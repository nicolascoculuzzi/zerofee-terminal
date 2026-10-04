import type { Address } from "@solana/kit";
import { formatInteger, formatQuote, formatSol, shortAddress } from "./format";
import type { SummaryAction } from "./types";

function who(address: Address, signer: Address, connectedWallet: Address): string {
  if (address === signer) return "the trading wallet";
  if (address === connectedWallet) return `your connected wallet ${shortAddress(address)}`;
  return shortAddress(address);
}

export function describeAction(action: SummaryAction, signer: Address, connectedWallet: Address): string {
  switch (action.kind) {
    case "trade": {
      const note = action.mayPayVenueRent
        ? ` If its platform or creator fee vault does not exist yet, ${action.venue} creates it with the trading wallet paying the rent (not refundable).`
        : action.route?.length
          ? ` Routed through ${action.route.join(" > ")}; the hops are not inspected, but the output must reach the trading wallet's own token account.`
          : "";
      if (action.side === "buy") {
        const amount =
          action.baseAmountIs === "min_out" ? `at least ${formatInteger(action.baseAmount)}` : formatInteger(action.baseAmount);
        return `Buy on ${action.venue} (${action.instruction}): spend up to ${formatQuote(action.maxQuoteIn ?? 0n, action.quoteMint)} for ${amount} base units of token ${shortAddress(action.baseMint)}.${note}`;
      }
      const sold = action.baseAmountIs === "max_in" ? `up to ${formatInteger(action.baseAmount)}` : formatInteger(action.baseAmount);
      return `Sell ${sold} base units of token ${shortAddress(action.baseMint)} on ${action.venue} (${action.instruction}) for at least ${formatQuote(action.minQuoteOut ?? 0n, action.quoteMint)}.${note}`;
    }
    case "extend_account":
      return `Pay the one-time rent to grow ${action.venue} pool ${shortAddress(action.account)} to its current size (required before trading on an older pool; not refundable).`;
    case "tip":
      return `Tip ${formatSol(action.lamports)} to landing tip account ${shortAddress(action.to)}.`;
    case "sol_transfer":
      return action.destination === "own_wsol_account"
        ? `Move ${formatSol(action.lamports)} into the trading wallet's wSOL account (wrap).`
        : `Send ${formatSol(action.lamports)} to ${who(action.to, signer, connectedWallet)}.`;
    case "token_transfer":
      return `Send ${formatInteger(action.amount)} base units of token ${shortAddress(action.mint)} to ${
        action.destination === "own_token_account" ? "the trading wallet's" : "your connected wallet's"
      } token account.`;
    case "close_account":
      return `Close token account ${shortAddress(action.account)}; its SOL goes to ${who(action.destination, signer, connectedWallet)}.`;
    case "sync_native":
      return `Sync the wSOL balance of ${shortAddress(action.account)}.`;
    case "revoke":
      return `Remove any delegate from token account ${shortAddress(action.account)}.`;
    case "create_ata":
      return `Create the token account for ${shortAddress(action.mint)} owned by ${who(action.owner, signer, connectedWallet)}${
        action.idempotent ? " if missing" : ""
      } (rent is refundable).`;
    case "nonce_advance":
      return `Advance durable nonce ${shortAddress(action.nonceAccount)}.`;
    case "nonce_withdraw":
      return `Withdraw ${formatSol(action.lamports)} from nonce account ${shortAddress(action.nonceAccount)} to ${who(action.to, signer, connectedWallet)}.`;
    case "nonce_create":
      return `Create nonce account ${shortAddress(action.nonceAccount)} with ${formatSol(action.lamports)}, controlled by the trading wallet.`;
  }
}
