/**
 * Armed-order REST (protocol orders.ts). Every route needs a session; mutations also need an allowed
 * Origin (CSRF, api/router.ts). Intake has its own per-user rate limit on top of the router's: verifying
 * a big grid's signatures costs CPU.
 */
import type {
  ArmOrdersResponse,
  CancelOrderResponse,
  NonceSlotsResponse,
  OrderDetailResponse,
  OrderLimits,
  OrdersListResponse,
  PanicResponse,
} from "@zerofee/protocol";
import { HttpError, json } from "../api/http";
import type { Route } from "../api/router";
import { uuid, ValidationError } from "../api/validate";
import type { RateLimiter } from "../gateway/rateLimit";
import type { OrderEngine } from "./engine";
import { IntakeError, type OrderIntake } from "./intake";
import type { ArmedOrdersRepo } from "./repo";
import { parseArmBody } from "./wire";

/** Largest intake body: a batch of big ladders (Bun.serve caps every body at 4 MiB). */
export const ARM_BODY_LIMIT = 3 * 1024 * 1024;
/** Orders per intake request. */
export const ARM_BATCH_MAX = 10;

export interface OrderRoutesDeps {
  engine: OrderEngine;
  intake: OrderIntake;
  repo: ArmedOrdersRepo;
  /** Intake requests per user. */
  intakeLimiter: RateLimiter;
  now: () => number;
}

/** Reads a UTF-8 body of at most `maxBytes`. */
async function readText(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "bad_request", `body too large (max ${maxBytes} bytes)`);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > maxBytes) throw new HttpError(413, "bad_request", `body too large (max ${maxBytes} bytes)`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new HttpError(400, "bad_request", "body is not valid UTF-8");
  }
}

const reject = (e: IntakeError) => json(e.body(), e.status);

export function orderRoutes(d: OrderRoutesDeps): Route[] {
  const { engine, intake, repo } = d;
  return [
    {
      method: "POST",
      path: "/api/orders/armed",
      auth: "session",
      handler: async (c) => {
        if (!d.intakeLimiter.allow(c.session.userId))
          return reject(new IntakeError(429, "rate_limited", "too many arming requests, slow down"));
        const text = await readText(c.req, ARM_BODY_LIMIT);
        let orders: ReturnType<typeof parseArmBody>;
        try {
          orders = parseArmBody(text, {
            maxAttempts: engine.cfg.maxAttempts,
            maxVariantsPerNonce: engine.cfg.maxVariantsPerNonce,
            maxOrders: ARM_BATCH_MAX,
          });
        } catch (e) {
          if (!(e instanceof ValidationError)) throw e;
          return reject(new IntakeError(400, "bad_request", e.message, [{ code: "malformed", orderId: "*", message: e.message }]));
        }
        try {
          const body: ArmOrdersResponse = { orders: await intake.arm(c.session.userId, orders) };
          return json(body, 201);
        } catch (e) {
          if (e instanceof IntakeError) return reject(e);
          throw e;
        }
      },
    },
    {
      method: "GET",
      path: "/api/orders",
      auth: "session",
      handler: async (c) => {
        const scope = c.url.searchParams.get("status") ?? "open";
        if (scope !== "open" && scope !== "all") throw new ValidationError("status must be open or all");
        const limit = Math.min(500, Math.max(1, Number(c.url.searchParams.get("limit") ?? 100) || 100));
        const body: OrdersListResponse = { orders: await repo.listViews(c.session.userId, { scope, limit }) };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/orders/limits",
      auth: "session",
      handler: async (c) => {
        const userId = c.session.userId;
        const tables = engine.lookupTables();
        const cfg = engine.cfg;
        const body: OrderLimits = {
          maxOpenOrders: cfg.maxOpenPerUser,
          maxArmedNotionalLamports: cfg.maxNotionalLamports.toString(),
          maxBuyLamports: (await intake.userBuyCap(userId)).toString(),
          maxGridDepthBps: cfg.maxGridDepthBps,
          maxTipLamports: cfg.maxTipLamports.toString(),
          maxPriorityFeeLamports: cfg.maxPriorityFeeLamports.toString(),
          maxAttempts: cfg.maxAttempts,
          maxVariantsPerNonce: cfg.maxVariantsPerNonce,
          maxBuyVariants: cfg.maxBuyVariants,
          lookupTables: tables ? Object.keys(tables) : [],
          openOrders: await repo.countActive(userId),
          armedNotionalLamports: engine.armedNotional(userId).toString(),
          dryRun: engine.dryRun,
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/orders/nonce-slots",
      auth: "session",
      handler: async (c) => {
        const body: NonceSlotsResponse = { slots: await repo.slots(c.session.userId) };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/orders/panic",
      auth: "session",
      handler: async (c) => {
        const body: PanicResponse = await engine.panic(c.session.userId);
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/orders/:id",
      auth: "session",
      handler: async (c) => {
        const id = uuid(c.params.id, "id");
        const order = await repo.view(c.session.userId, id);
        if (!order) throw new HttpError(404, "not_found", "no such order");
        const body: OrderDetailResponse = { order, events: await repo.events(id) };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/orders/:id/cancel",
      auth: "session",
      handler: async (c) => {
        const id = uuid(c.params.id, "id");
        const orders = await engine.cancel(c.session.userId, id);
        if (!orders) {
          const view = await repo.view(c.session.userId, id);
          if (!view) throw new HttpError(404, "not_found", "no such order");
          throw new HttpError(409, "conflict", `the order is already ${view.status} and its nonces are consumed: nothing to cancel`);
        }
        const body: CancelOrderResponse = { orders };
        return json(body);
      },
    },
  ];
}
