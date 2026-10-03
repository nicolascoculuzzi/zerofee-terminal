# Privy as the embedded-wallet and server-signing layer for a hosted Solana memecoin terminal (as of 2026-10-03)

Method note: most facts below come from Privy's own docs. I pulled the full doc corpus from `https://docs.privy.io/llms-full.txt` (793 pages) on 2026-10-03 and cite each page by its canonical URL. I also used privy.io/pricing, privy.io blog posts (dates given inline), status.privy.io and the npm registry. WebSearch was not available, so nothing here comes from third-party press. Anything I took from memory and could not check this session is marked **[unverified]**.

Package versions on npm (checked 2026-10-03):
- `@privy-io/node` 0.35.0, published 2026-09-21. This is the current server SDK.
- `@privy-io/server-auth` 1.32.5, published 2025-09-17. It is **deprecated**, and npm says "use @privy-io/node instead".
- `@privy-io/react-auth` 3.47.0, published 2026-10-02.

Sources: [npm @privy-io/node](https://registry.npmjs.org/@privy-io/node), [npm @privy-io/server-auth](https://registry.npmjs.org/@privy-io/server-auth), [Migrating from server-auth](https://docs.privy.io/basics/nodeJS/advanced/migrating-from-server-auth)

---

## 1. Auth: login methods, MFA, sessions, and auto-creating a Solana wallet on sign-up

### Takeaway
Privy covers every login method we need: email OTP, SMS, passkeys, Google, X/Twitter, Telegram, external Solana wallets (SIWS) and more. Wallet MFA can use passkeys, TOTP or SMS.

There are two ways to give every user a Solana wallet:
- **Privy modal login:** set `embeddedWallets.solana.createOnLogin`.
- **Custom (whitelabel) login UI:** call `useCreateWallet` from `@privy-io/react-auth/solana`. This hook can attach our server signer in the same call.

Sessions use a short-lived access token, about 1 hour, that refreshes automatically. Our Bun backend verifies it.

### Cited Findings
- **Login methods by security model.**
  - "Direct" methods: Passkey (WebAuthn) and Wallets (Sign-In With Ethereum / Sign-In With Solana).
  - "Delegated" methods: OAuth/socials (Google, Apple, Twitter, Discord, GitHub, LinkedIn, Spotify, Telegram, Farcaster, and more), plus Email or SMS one-time passcode.
  - Any of these can be set up as an upfront login method or as an account the user links later.
  - Source: [Using Privy as your authentication provider](https://docs.privy.io/authentication/user-authentication/privy-auth)
- Privy warns: "Account access is wallet access. If your app uses a delegated login method as the primary authenticator, Privy recommends requiring MFA with either a passkey or authenticator app." — [same page](https://docs.privy.io/authentication/user-authentication/privy-auth)
- Native OAuth provider values are `'google'`, `'apple'`, `'twitter'`, `'github'`, `'discord'`, `'linkedin'`, `'spotify'`, `'tiktok'`, `'instagram'`, `'telegram'`, `'line'`. Custom OAuth 2.0 and JWT-based auth (Auth0, Firebase, Cognito, OIDC) are also supported. Google OAuth may fail in in-app browsers. — [OAuth](https://docs.privy.io/authentication/user-authentication/login-methods/oauth), [JWT-based auth](https://docs.privy.io/authentication/user-authentication/jwt-based-auth/overview)
- **Wallet MFA.**
  - Methods: passkeys (recommended), TOTP, SMS. Privy warns that SMS is vulnerable to SIM-swapping.
  - Once a user enrolls, MFA is required for "signing messages, sending transactions, exporting the wallet, and recovering the wallet on new devices", subject to a dashboard-configurable verification duration.
  - Enrollment applies to **all** of a user's embedded wallets.
  - "Policy-based MFA" can require MFA only for certain actions, such as withdrawals.
  - Source: [MFA overview](https://docs.privy.io/authentication/user-authentication/mfa/overview)
- **Sessions.**
  - After login, Privy issues an access token (JWT). Its expiry "is generally 1 hour after" issue.
  - `getAccessToken` from `usePrivy` auto-refreshes it.
  - The token travels either as a `Bearer` header (local-storage mode) or as the `privy-token` HttpOnly cookie (cookie mode).
  - The token's claims include a session ID.
  - Source: [Access tokens](https://docs.privy.io/authentication/user-authentication/access-tokens)
- To verify tokens without a network call to Privy, pass `jwtVerificationKey` (copied from the Dashboard) into `new PrivyClient({...})`. Identity tokens let the server read user data without calling the API. — [Optimize your setup](https://docs.privy.io/recipes/dashboard/optimizing)
- **Auto-creating a Solana wallet in React:**
  ```tsx
  <PrivyProvider appId="..." config={{ embeddedWallets: { solana: { createOnLogin: 'users-without-wallets' } } }}>
  ```
  Allowed values: `'all-users' | 'users-without-wallets' | 'off'`. — [Automatic wallet creation](https://docs.privy.io/basics/react/advanced/automatic-wallet-creation)
- **Caveat:** "Automatic wallet creation only applies to login via the Privy modal and not from whitelabel login methods… like loginWithCode, useLoginWithOAuth." A custom UI has to call `createWallet` manually. — [same page](https://docs.privy.io/basics/react/advanced/automatic-wallet-creation)
- **Manual creation with a signer attached:**
  - Hook: `useCreateWallet` from `@privy-io/react-auth/solana`.
  - Signature: `createWallet({createAdditional?: boolean, signers?: {signerId: string, policyIds?: string[]}[]})`.
  - So a wallet can be created and delegated to our server in one call.
  - Source: [Create a wallet](https://docs.privy.io/wallets/wallets/create/create-a-wallet)
- **Server SDK runtimes:** `@privy-io/node` supports Node 20+, Deno ≥1.28, **Bun ≥1.0**, Cloudflare Workers, Vercel Edge and Nitro. — [Node setup](https://docs.privy.io/basics/nodeJS/setup)
- **Bot protection:** Privy recommends invisible CAPTCHA (hCaptcha or Turnstile), blocking VoIP numbers, blocking "+" emails and blocking temporary email domains. — [Pricing FAQ](https://www.privy.io/pricing)

### Inferences
- For an Axiom-style flow, use one of two options:
  - **Privy modal:** with `createOnLogin: 'users-without-wallets'`, then call `addSigners` in `useLogin({onComplete})`.
  - **Custom login UI:** call `createWallet({signers:[{signerId, policyIds:[policyId]}]})` right after login.

  Either way the user sees one "allow trading" consent at onboarding and nothing per trade.
- Because "account access is wallet access", we should push passkey or TOTP MFA, and make it mandatory for withdrawals and export (see Policies). Email OTP alone is the weakest link.

### Gaps
- No doc says whether a user's wallet-MFA enrollment also gates requests signed by an *app signer*. I believe it does not, since signer requests are authorized by our P-256 key and not by the user, but this is unverified. Test it in staging.
- No refresh-token lifetime or maximum session length was found in the pages I read.

---

## 2. Server-side signing: the 2026 mechanism, grant/revoke, SDK and REST, sign-only vs sign-and-send

### Takeaway
In 2026 Privy calls this **signers**. The older names "session signers" and "delegated actions" still appear in docs and code.

How it works:
- Our backend holds a **P-256 authorization key**.
- We register its public half as a **key quorum**, usually 1-of-1. The key quorum ID *is* the signer ID.
- The user adds that signer to their wallet, optionally with **one** override policy, using `useSigners().addSigners`. The user revokes with `removeSigners`.
- The backend then calls `privy.wallets().solana().signTransaction(walletId, {transaction, authorization_context})` from `@privy-io/node`, or `POST /v1/wallets/{id}/rpc` over REST.

**Sign-only is fully supported.** `signTransaction` returns the signed base64 transaction, which we can submit through Helius Sender or Jito ourselves. Alternatively, `signAndSendTransaction` with `optimistic_broadcast: true` returns the signed transaction immediately while Privy also broadcasts it through Jito FullSend.

### Cited Findings
- **What signers are for.** Privy lets an app "add **signers** to wallets that can take actions within the scope of certain permissions". The listed use cases include "execute limit orders or agentic trades even while a user is offline". It adds: "a **signer** will never see the wallet's private key. All signing takes place in a secure enclave." — [Signers overview](https://docs.privy.io/wallets/using-wallets/signers/overview)
- **A signer is a key quorum.** "Fundamentally, a signer is a key quorum that is authorized to submit transaction request for signature from a user's wallet." The authorization key "is the private key of a P-256 keypair. Privy never sees the private key." — [Configure signers](https://docs.privy.io/wallets/using-wallets/signers/configure-signers)
- **Setup steps from the quickstart:**
  1. Generate a key with `openssl ecparam -name prime256v1 -genkey -noout -out private.pem && openssl ec -in private.pem -pubout -out public.pem`.
  2. Register the public key in Dashboard → Authorization keys → "Register key quorum instead", with threshold 1. The REST alternative is `/api-reference/key-quorums/create`.
  3. Save the key quorum `id`.
  4. Optionally create a policy.
  5. Have the user add the signer.

  Source: [Signers quickstart](https://docs.privy.io/wallets/using-wallets/signers/quickstart)
- **Granting from React:**
  - Signature: `addSigners: async ({address: string, signers: {signerId: string, policyIds: string[]}[]}) => Promise<{user: User}>`.
  - Import: `import {useSigners} from '@privy-io/react-auth'`.
  - Docs note: "at this time, each signer can only have one override policy." If no policy is given, "no policies will apply to the signers requests."
  - Source: [Add signers](https://docs.privy.io/wallets/using-wallets/signers/add-signers)
- **Granting from Node/REST:** "Make a request to update the wallet with the desired `additional_signers`… The wallet owner must sign the request." Each `additional_signers` entry takes a key quorum ID and `override_policy_ids`. — [Add signers](https://docs.privy.io/wallets/using-wallets/signers/add-signers), [API reference text](https://docs.privy.io/llms-full.txt)
- **Revoking from React:**
  - Signature: `removeSigners: async ({address: string}) => Promise<{user: User}>`.
  - It "will remove all the signers, so only the user can transact on the wallet."
  - The native Swift, Android and Flutter SDKs also have `removeSigner(signerId)` and `removeAllSigners()`.
  - Source: [Remove signers](https://docs.privy.io/wallets/using-wallets/signers/remove-signers)
- **Finding delegated wallets server-side:** `privy.users()._get(did)`, then filter `linked_accounts` for `type === 'wallet' && account.delegated`. "Wallets with signers will always have the `delegated` flag set to `true`." — [Use signers](https://docs.privy.io/wallets/using-wallets/signers/use-signers)
- **Authorization context in `@privy-io/node`.** Server SDKs sign requests automatically through an "authorization context". It can hold any of:
  - `authorization_private_keys: ['...']`
  - `user_jwts: [...]`
  - a **custom signing function**, e.g. to sign in KMS. It must "perform an ECDSA P-256 signature on the payload… and return the base64-encoded signature."
  - precomputed signatures

  Source: [Signing on the server](https://docs.privy.io/controls/authorization-keys/using-owners/sign/signing-on-the-server)
- **Node sign-only example.** From the Kamino recipe:
  ```ts
  await privy.wallets().solana().signTransaction(walletId, { transaction: serializedTx, authorization_context: { authorization_private_keys: [AUTH_KEY_PRIVATE] } })
  ```
  The recipe then sends `signResponse.signed_transaction` with its own RPC using `skipPreflight: true`. — [Kamino guide](https://docs.privy.io/recipes/yield/kamino-guide)
  - Note: the Solana sign page instead destructures `{signedTransaction}` from the same call ([Sign a transaction](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction)). Check the response field name against the 0.35.0 types.
- **REST sign-only:**
  - Request: `POST https://api.privy.io/v1/wallets/<wallet_id>/rpc` with Basic auth (`app-id:app-secret`) and headers `privy-app-id` and `privy-authorization-signature`.
  - Body: `{"method":"signTransaction","params":{"transaction":"<base64>","encoding":"base64"}}`.
  - Response: `data.signed_transaction`. Only `base64` encoding is supported.
  - Source: [Sign a transaction (Solana)](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction), [API ref signTransaction](https://docs.privy.io/api-reference/wallets/solana/sign-transaction)
- **Optional request headers:**
  - `privy-request-expiry`: a Unix-ms deadline that is part of the signature payload and prevents replay. Privy "strongly recommend[s]" it for signed requests.
  - `privy-idempotency-key`: on 4xx/5xx, Privy caches the response and replays it for the same key, so retry with a new key after a server error. Policy violations allow same-key retries.
  - Source: [Request expiry](https://docs.privy.io/api-reference/request-expiry), [API ref signTransaction](https://docs.privy.io/api-reference/wallets/solana/sign-transaction)
- **Node sign-and-send:**
  ```ts
  privy.wallets().solana().signAndSendTransaction(walletId, { caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', transaction: base64, sponsor: true })
  ```
  It returns `{hash}`. The REST call uses the same `/rpc` endpoint with `"method":"signAndSendTransaction"`. — [Send a transaction (Solana)](https://docs.privy.io/wallets/using-wallets/solana/send-a-transaction)
- **Sign-and-send options** ([API ref signAndSendTransaction](https://docs.privy.io/api-reference/wallets/solana/sign-and-send-transaction)):
  - `reference_id`: up to 64 characters, for reconciliation.
  - `optimistic_broadcast`: "the signed transaction will be immediately returned after the enclave signs, and submission to the network will happen asynchronously… disables network preflight checks… You are responsible for rebroadcasting and validating."
  - Lowest-latency tip: combine `optimistic_broadcast` with the header `x-privy-skip-simulation: true`.
  - The endpoint is synchronous and does not wait for confirmation or retry.
- **Simulation before policy:** "For operations where Privy both signs and broadcasts a transaction, transaction simulation runs before policy evaluation." — [Policies overview](https://docs.privy.io/controls/policies/overview)
- **Privy's broadcast route:** "Every Solana transaction broadcast through Privy's TEE wallets is routed through FullSend [built with Jito]… with MEV protection built in by default." Privy reports 99.999% landing reliability since January 2026 and submission "in as little as 4 milliseconds". (Privy blog, Jul 9, 2026.) — [High-performance Solana transaction landing](https://www.privy.io/blog/high-performance-solana-transaction-landing-built-into-privy)
- **Advanced swap (Labs, experimental):**
  - Endpoint: `POST /v1/wallets/{wallet_id}/experimental/solana/advanced-swap`.
  - Quote, enclave signing and submission happen in one synchronous request. It returns `signed_transaction` for rebroadcast.
  - Requires app approval and is "available for enterprise customers".
  - Privy gives at least 3 months' notice before removing a Labs API.
  - Sources: [Advanced swap](https://docs.privy.io/api-reference/labs/advanced-swap), [Labs overview](https://docs.privy.io/api-reference/labs/overview), [Reducing trading latency (May 27, 2026)](https://www.privy.io/blog/reducing-trading-latency-on-privy)
- **History of the naming.**
  - Older hooks `useDelegatedActions` / `useHeadlessDelegatedActions` (`delegateWallet`) came from the on-device wallet era. They were replaced by `useSessionSigners` and now by `useSigners`.
  - Migrating to TEE execution "will reset all delegations".
  - Signers and the policy engine *require* TEE execution. New apps use it.
  - Sources: [TEE migration guide](https://docs.privy.io/recipes/tee-wallet-migration-guide); hook names from the docs corpus ([llms-full.txt](https://docs.privy.io/llms-full.txt))
- **Other server patterns:**
  - Wallets owned by an authorization key ("server wallets", e.g. `privy.wallets().create({chain_type:'solana', owner_id: AUTH_KEY_ID})`).
  - 2-of-2 user+server key quorums.
  - User-signed requests relayed via the server.
  - Sources: [Create a wallet](https://docs.privy.io/wallets/wallets/create/create-a-wallet), [Sending transactions from your server](https://docs.privy.io/controls/authorization-keys/owners/configuration/user/server-transactions), [Kamino guide](https://docs.privy.io/recipes/yield/kamino-guide)
- **IP allowlist:** this can restrict app-secret (Basic auth) API calls to our server IPs/CIDRs. Non-matching requests get 403. — [IP allowlist](https://docs.privy.io/security/implementation-guide/ip-allowlist)

### Inferences
- The right model for a user-custodied terminal is **user-owned wallet + app signer (1-of-1 key quorum) + override policy**. Two other options exist:
  - App-owned server wallets would make us custodial.
  - A 2-of-2 quorum would block the user's unilateral export.
- Use `signTransaction`, not `signAndSendTransaction`, as the default path. We keep full control of routing (Helius Sender, Jito bundles, our own retries), and Privy runs no simulation on sign-only, per the simulation note above. The latency section explains why this matters.
- `signAndSendTransaction` + `optimistic_broadcast` + `x-privy-skip-simulation` is the alternative. It gives free dual-path broadcast: Privy's FullSend plus our own rebroadcast of the returned `signed_transaction`. It is worth A/B testing on landing rate.
- Keep the P-256 authorization key in a KMS/HSM and use the SDK's custom-sign-function hook, so the raw key never sits in Bun process memory. Also turn on the IP allowlist and set `privy-request-expiry` to roughly now + 2–5 s on every trade.

### Gaps
- No doc gives a per-app or per-wallet cap on the number of signers.
- No doc gives a webhook for "user removed signer". The server has to check `delegated` itself, or handle the failing sign request.

---

## 3. Policies: restricting what the backend can sign on Solana

### Takeaway
Privy's policy engine runs inside the TEE. It evaluates **every top-level instruction** of a Solana transaction, and **all** of them must hit an ALLOW rule. DENY rules beat ALLOW rules, and anything unmatched is denied.

What it can do on Solana:
- allowlist program IDs
- allowlist System Program instruction types and transfer destinations (e.g. Jito tip accounts)
- cap lamports per System transfer
- cap decoded Anchor-instruction arguments with an IDL (e.g. a DEX buy's max-SOL argument)
- time-box the signer
- block `exportPrivateKey`

What it cannot do on Solana today:
- **Stateful rate or spend limits.** Aggregations are documented as Ethereum-only.
- **Address-based conditions on addresses loaded from Address Lookup Tables.**
- **Decoding SPL Token instructions outside a fixed set.** Only Transfer, TransferChecked, Burn, MintTo, CloseAccount and InitializeAccount3 can be decoded.

### Cited Findings
- **Evaluation rules.** "`DENY` actions take precedence over `ALLOW` actions. If no rules resolve, the policy will default to `DENY`." Also: "every Instruction in a Solana transaction is evaluated against the rules of the policy. Every instruction must evaluate to an `ALLOW` action for the transaction to be allowed." Policies are enforced in the TEE "before signing or exporting key material". — [Policies overview](https://docs.privy.io/controls/policies/overview)
- **Rules are per RPC method.** If a policy lacks a rule for a method, that method is denied. Solana methods are `'signTransaction' | 'signAndSendTransaction' | 'signMessage' | 'exportPrivateKey' | ...`, and `'*'` is allowed as a method in examples. — [Policies overview](https://docs.privy.io/controls/policies/overview), [Solana examples](https://docs.privy.io/controls/policies/example-policies/solana)
- **Solana field sources** ([Policies overview](https://docs.privy.io/controls/policies/overview)):
  - `solana_program_instruction` (`programId`)
  - `solana_system_program_instruction` (`instructionName`, `Transfer.to`, `Transfer.from`, `Transfer.lamports`)
  - `solana_token_program_instruction`: supports only "Transfer, TransferChecked, Burn, MintTo, CloseAccount, and InitializeAccount3"
  - `solana_instruction_data`: Anchor IDL decoding
  - `system` (`current_unix_timestamp`)
  - `message` (for `signMessage`)
- **Operators and value units:** `eq, neq, lt, lte, gt, gte, in, in_condition_set, contains, starts_with, ends_with`. `in` takes up to 100 values; above that, use condition sets. Values are compared raw, so "SOL in lamports". — [Policies overview](https://docs.privy.io/controls/policies/overview)
- **Program allowlist (documented example):**
  ```ts
  { version:'1.0', name:'Allowlisted programs', chain_type:'solana', rules:[{ name:'...', method:'signAndSendTransaction',
    conditions:[{ field_source:'solana_program_instruction', field:'programId', operator:'in',
      value:['ComputeBudget111111111111111111111111111111','11111111111111111111111111111111'] }], action:'ALLOW' }] }
  ```
  Another documented example allowlists Jupiter v6 `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` alongside Compute Budget. — [Solana examples](https://docs.privy.io/controls/policies/example-policies/solana)
- **SOL transfer cap + recipient allowlist (documented example):** a rule with `Transfer.lamports lte '1000000000'` **and** `Transfer.to in [...]`, action ALLOW. — [Solana examples](https://docs.privy.io/controls/policies/example-policies/solana)
- **Anti-pattern:** a second rule that ALLOWs all `instructionName eq 'Transfer'` "will override the previous rule". In the same way, allowlisting the System Program by `programId` allows *any* System instruction, including uncapped transfers to anyone. — [Solana examples](https://docs.privy.io/controls/policies/example-policies/solana)
- **Blocking key export:**
  ```ts
  rules:[{ name:'Block private key exports', method:'exportPrivateKey', conditions:[], action:'DENY' }, { name:'Allow all other actions', method:'*', conditions:[], action:'ALLOW' }]
  ```
  Source: [Solana examples](https://docs.privy.io/controls/policies/example-policies/solana)
- **Time-boxed signer:** two conditions on `system.current_unix_timestamp`, `gte` start and `lt` end. — [Solana examples](https://docs.privy.io/controls/policies/example-policies/solana)
- **IDL conditions** ([Solana IDL examples](https://docs.privy.io/controls/policies/example-policies/solana-idls)):
  - `solana_instruction_data` with an `idl` (modern Anchor ≥0.30 format, ≤32 KB each, ≤128 KB per policy).
  - Fields: `instruction_name`, `discriminator`, `<ix>.args.<arg>`, `<ix>.accounts.<account>`.
  - Integer args support `lt/lte/gt/gte`.
  - Each IDL condition must be paired with a `programId` condition, because "An IDL condition matches any instruction whose data begins with a discriminator from the IDL, regardless of which program it calls."
  - Template variables are not supported in IDL conditions.
  - Documented example: Marinade `deposit.args.lamports lte '1000000000'`.
- **Address Lookup Tables:** "Solana policy evaluation does not support resolving addresses from Address Lookup Tables (ALTs). If your policy has conditions that reference addresses stored in an ALT… the transaction will be rejected." Policies that check only `programId`, `instructionName`, amounts or time "work fine with ALT transactions". — [Solana examples](https://docs.privy.io/controls/policies/example-policies/solana)
- **Template variable:** `{{wallet.address}}` resolves to the signing wallet's address and works with `eq`/`in` on address fields. It cannot be used in `in_condition_set` or aggregations. — [Template variables](https://docs.privy.io/controls/policies/template-variables)
- **Stateful policies:**
  - Aggregations (rolling-window sums and counts) enable "rate limiting" and "spending caps".
  - Maximum of **10 aggregations per app**.
  - The `reference` field source is "Only supported for Ethereum methods (`eth_signTransaction`, `eth_signUserOperation`)".
  - Sources: [Stateful policies](https://docs.privy.io/controls/policies/stateful-policies), [Policies overview](https://docs.privy.io/controls/policies/overview)
- **Override policies per signer:** "When a signer submits a transaction, Privy evaluates only that signer's override policy — not the policies of other signers." — [Conditional policies per signer](https://docs.privy.io/recipes/wallets/conditional-signer-policies)
- **Policy ownership:** "If a policy has an owner, the owner's signature is required to modify the policy." Rules can be added and edited one at a time with `privy.policies().createRule(...)` / `updateRule(...)` or `POST /v1/policies/<policy_id>/rules`. — [Update a policy](https://docs.privy.io/controls/policies/update-a-policy)

### Proposed default signer policy (my draft from the documented schema; **test in staging before relying on it**)
Program IDs below other than ComputeBudget, System and Jupiter v6 are from memory **[unverified]**. Check each against the protocols' own docs, and check whether pump.fun now routes some coins through Token-2022 or a fees program.

```ts
{
  version: '1.0',
  name: 'terminal-trading-signer-v1',
  chain_type: 'solana',
  rules: [
    // 1. DEX / infra programs (top-level instructions only). Do NOT list System or SPL Token program IDs here.
    { name: 'Allow trading programs', method: 'signTransaction', action: 'ALLOW', conditions: [{
        field_source: 'solana_program_instruction', field: 'programId', operator: 'in', value: [
          'ComputeBudget111111111111111111111111111111',   // documented
          'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',   // Jupiter v6, documented
          '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',   // pump.fun bonding curve [unverified]
          'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',   // PumpSwap AMM [unverified]
          '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  // Raydium AMM v4 [unverified]
          'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',  // Raydium CPMM [unverified]
          'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',  // Raydium CLMM [unverified]
          'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',   // Raydium LaunchLab [unverified]
          'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'   // Associated Token Account program (CreateIdempotent) [unverified ID]
        ] }] },
    // 2. SOL tips only to tip accounts, capped (e.g. <= 0.05 SOL). Tip account must be a STATIC key (not via ALT).
    { name: 'Allow capped tips', method: 'signTransaction', action: 'ALLOW', conditions: [
        { field_source: 'solana_system_program_instruction', field: 'instructionName', operator: 'eq', value: 'Transfer' },
        { field_source: 'solana_system_program_instruction', field: 'Transfer.to', operator: 'in',
          value: [/* 8 Jito tip accounts + Helius Sender tip accounts — fill from Jito/Helius docs */] },
        { field_source: 'solana_system_program_instruction', field: 'Transfer.lamports', operator: 'lte', value: '50000000' } ] },
    // 3. Token housekeeping that the token field source can decode.
    { name: 'Allow token account close', method: 'signTransaction', action: 'ALLOW', conditions: [
        { field_source: 'solana_token_program_instruction', field: 'instructionName', operator: 'in', value: ['CloseAccount', 'InitializeAccount3'] } ] },
    // 4. Optional per-trade size cap via IDL, e.g. pump.fun buy max SOL (pair with programId). IDL must be trimmed Anchor>=0.30 JSON.
    // { name:'Cap pump.fun buy size', method:'signTransaction', action:'DENY', conditions:[
    //   { field_source:'solana_program_instruction', field:'programId', operator:'eq', value:'6EF8...' },
    //   { field_source:'solana_instruction_data', idl: PUMP_IDL_TRIMMED, field:'buy.args.max_sol_cost', operator:'gt', value:'<cap lamports>' } ] },
    // 5. Hard denies.
    { name: 'No key export by app signer', method: 'exportPrivateKey', action: 'DENY', conditions: [] }
    // No signMessage rule => app signer cannot sign arbitrary messages (default deny).
  ]
}
```

What this enforces: there are no rules for SPL `Transfer`/`TransferChecked`, and no general System `Transfer` outside tip accounts. Because unmatched instructions are denied, **withdrawals of SOL or tokens to arbitrary addresses get no ALLOW and are rejected**. The user then has to withdraw from the frontend with their own session, where `useSigners`'s policy does not apply to them.

### Inferences
- **The WSOL problem.** Many PumpSwap, Raydium and Jupiter routes emit top-level instructions that this policy would reject:
  - `System Transfer` to the user's own WSOL ATA. That is *not* the wallet address, so `{{wallet.address}}` won't match it.
  - `SyncNative`, which is not in the token field source's decodable list.

  Options:
  - **(a)** Build transactions so wrapping happens through CPI inside an allowlisted program. My understanding is that policies only see top-level instructions, but this is unverified.
  - **(b)** Create a **per-wallet** policy at onboarding that adds the user's deterministic WSOL ATA to the `Transfer.to` allowlist.
  - **(c)** Allowlist the SPL Token program by `programId` and add DENY rules for `Transfer`/`TransferChecked`. This is risky: undecodable instructions such as `SetAuthority`/`Approve` would then be allowed, and those could hand token accounts to an attacker.

  Prefer (a) or (b).
- **Residual risk even with a perfect policy.** A stolen signer key can still burn value *through* allowlisted DEX programs. Examples: buying an attacker-created pump.fun coin, or selling into a manipulated pool. Solana has no stateful aggregations, so Privy cannot cap daily spend. Per-trade caps (IDL arg limits) and per-user rate limits must also live in **our own signing service**, isolated from the public API.
- **Make the policy's owner a separate, offline/multi-party key quorum,** not the hot signing key. Then a compromised trade server cannot loosen the policy. The doc only says the owner's signature is required if an owner is set. I infer that an owner-less policy can be modified with just app credentials.
- Write rules for **`signTransaction`**, the method we actually call. Privy's examples all use `signAndSendTransaction`. If we also use optimistic sign-and-send, duplicate the rules for that method.
- Keep tip accounts and any other address checked by the policy in **static account keys**. Put pool and route accounts in ALTs freely. Program IDs must be static keys anyway (a Solana rule, from general knowledge).

### Gaps
- No documented limit on rules per policy, total policies per app, or condition-set sizes, beyond `in` ≤100 values and the IDL size limits.
- Not documented: whether `instructionName` for the System Program supports `AdvanceNonceAccount`, `CreateAccountWithSeed`, etc. Examples only show `Create` and `Transfer`.
- Not documented whether an IDL with a 1-byte discriminator could be used to decode SPL Token instructions like `SyncNative`/`SetAuthority`. That needs testing.
- Policy-evaluation latency overhead is not published separately.

---

## 4. Latency, regions, rate limits

### Takeaway
Privy's own benchmark (SLATE, 1,000 runs, May 2026) puts **TEE signing at a median of 72.42 ms for Solana**. That figure includes a network-proxy bypass you request from Privy, which saves about 20 ms, so expect roughly 90 ms without it.

Other figures:
- All wallet operations got 30–45 ms faster in May 2026.
- Multi-region signing went live in August 2025.
- The enterprise-only Labs advanced-swap endpoint does quote, sign and submit in about 190 ms end to end.

Rate limits are per-endpoint, return HTTP 429, and the numbers are not published.

### Cited Findings
- **May 27, 2026 latency work:**
  - "all wallet operations on Privy are 30–45ms faster across chains", from enclave prewarming, parallel data loading and co-location.
  - "With the network proxy bypass, we see a latency reduction of about 20ms. From re-running SLATE with 1000 runs… EVM Median: 83.62ms, Solana Median: 72.42ms. If you'd like to enable the proxy bypass, contact us."
  - The swap API reaches "end-to-end swap latency of about 190ms". The "fast-RPC signAndSendTransaction improvements are live now, and the advanced swap API is available for enterprise customers."
  - Source: [Reducing trading latency on Privy (May 27, 2026)](https://www.privy.io/blog/reducing-trading-latency-on-privy)
- **Multi-region (Aug 20, 2025, older):** multi-region wallet infrastructure is live for all customers. Signature latency dropped by "~50-75% for our global users". Requests are "automatically sent to the closest accessible area". The post does not name specific regions. — [Lowering latency with multi-region wallet infrastructure](https://www.privy.io/blog/lowering-latency-with-multi-region-wallet-infrastructure)
- **SLATE (Oct 9, 2025):** Privy's open-source signing-latency benchmark measures "only the actual API call" and can run from any AWS region. Privy *on-device* signing is "<5ms", which doesn't apply to server signing. — [Introducing SLATE](https://www.privy.io/blog/introducing-slate-open-benchmark-for-wallet-signing-latency)
- **Rate limits:** "Privy rate limits REST API endpoints." Exceeding them returns `429 Too Many Requests`, and "Rate limits are applied per endpoint." The docs recommend exponential backoff with jitter and batching. — [Optimize your setup](https://docs.privy.io/recipes/dashboard/optimizing), [Node setup](https://docs.privy.io/basics/nodeJS/setup)
- **Privy broadcast:** submission to FullSend in "as little as 4 milliseconds, compared to an average of 25 milliseconds for customers connecting independently". (Privy-reported.) — [Solana landing post (Jul 9, 2026)](https://www.privy.io/blog/high-performance-solana-transaction-landing-built-into-privy)

### Inferences
- **Extra latency per trade on the sign-only path:** about 70–95 ms of Privy round trip, plus the network distance from our backend to Privy's nearest region, on top of building and submitting the transaction. That is roughly the cost of 1 Solana slot (~400 ms) × 0.2. It matters for sniping but is acceptable for a hosted terminal.
- **Ways to minimise it:**
  - Co-locate the backend in the same AWS region Privy routes us to. Measure with SLATE from candidate regions.
  - Ask Privy for the proxy bypass.
  - Keep a warm keep-alive HTTP/2 connection.
  - Pre-verify JWTs locally with `jwtVerificationKey`.
  - Build transactions while the user is still choosing size.
  - Don't let the 429 backoff path sit on the hot path; get explicit limits from Privy.
- **Avoid wasted signatures:** never re-sign the same trade just to resend it. Re-broadcast the same signed bytes to Sender and Jito in parallel. Each re-sign costs latency and a billable signature.

### Gaps
- No published per-app request-rate limits for `/v1/wallets/{id}/rpc`. Ask Privy sales/support for the quota and whether it can be raised.
- No published list of signing regions, and no p95/p99 figures (only medians).
- All latency numbers are **Privy-measured** marketing figures. No independent benchmark was retrieved because WebSearch was unavailable.

---

## 5. Security model, export, recovery, uptime, compliance, Stripe

### Takeaway
How keys are protected:
- Keys are created inside **AWS Nitro Enclaves**.
- Each key is split with Shamir's secret sharing into a 2-of-2: an enclave share plus an auth share.
- The full key exists only briefly inside the enclave, after the authorization signature and policy checks pass.

What each party can do:
- **Privy** says neither it nor its staff can reconstruct keys.
- **Our app** can sign only within the scope we were granted (signer + policy).
- **Users** can always export their key: in the web SDK, or directly via the API using their access token.

Compliance and history:
- Privy holds SOC 2 Type I and II, renewed Apr 2026.
- It is "a Stripe company".
- Its one disclosed 2026 incident (third-party Metabase, Aug 2026) exposed emails and some metadata, not wallets.
- There is no public SLA except "Premium SLAs" for Enterprise.

### Cited Findings
- **Architecture** ([Security architecture](https://docs.privy.io/security/wallet-infrastructure/architecture)):
  - Privy uses AWS Nitro Enclaves.
  - Wallets are created from 128-bit CSPRNG entropy → BIP-39, and every wallet is HD.
  - Each wallet is split into an "Enclave share" (decryptable only in the TEE) and an "Auth share" (encrypted, stored by Privy, released with valid auth). This is a 2-of-2.
  - Signing flow: API authenticates the credential → forwards to TEE with the auth share → "The TEE verifies authorization and policies" → reconstructs the key in memory → signs → returns.
- **Enclave controls** ([Secure enclaves](https://docs.privy.io/security/wallet-infrastructure/secure-enclaves)):
  - Measured boot, sealed secrets and multi-party-reviewed enclave deploys.
  - "Privy team members cannot reconstruct keys or bypass policy checks."
  - Customer access to attestation documents is "Coming soon".
- **Custody and delegated authority** ([Security FAQ](https://docs.privy.io/security/security-faqs)):
  - Embedded wallets are "non-custodial (self-custodial) by default".
  - "If a developer configures session signers… those signers can execute transactions within their granted scope without per-transaction user approval. This is delegated authority… not a general ability for Privy to move funds at will."
- **Portability** ([Security FAQ](https://docs.privy.io/security/security-faqs)):
  - Users can export their full private key (ed25519 for Solana) "via the client SDK key export flow or the REST API (POST /wallets/<id>/export)".
  - "no contractual lock-in on key material."
- **Export from the client** ([Export a wallet](https://docs.privy.io/wallets/wallets/export)):
  - Use `useExportWallet` from `@privy-io/react-auth/solana`, then `exportWallet()`, which opens a modal.
  - Client-created wallets can only be exported via the **React (web)** SDK. Privy has a WebView recipe for mobile.
  - "users can send transactions or export their keys using their access token with the Privy API, even if an application does not implement Privy's `exportWallet` method." Preventing that requires a 2-of-2 key quorum as owner.
- **Validation and response** ([Security overview](https://docs.privy.io/security/overview)):
  - Audits by Cure53, Zellic and Doyensec. "SOC2 Type I and Type II compliant." A HackerOne bug bounty. "24/7 incident response with rapid response SLAs."
  - Privy claims to secure "over 120 million users' wallets" and "over 15 billion dollars in monthly transaction value".
- **SOC 2 renewal (Apr 13, 2026)** ([Privy renews SOC 2 Type II](https://www.privy.io/blog/privy-renews-soc-2-type-ii-compliance)):
  - The audit period ran Nov 1, 2025 – Feb 1, 2026.
  - "As a Stripe company, Privy is covered under Stripe's robust insurance program."
  - Reports are available at trust.privy.io.
- **Incident (Aug 6, 2026):** a breach at third-party Metabase (analytics/support) exposed "customer and end-user email addresses and small subset of developer-set custom metadata fields". "Privy wallet infrastructure and authentication systems were not affected." — [Post mortem (Aug 10, 2026)](https://www.privy.io/blog/post-mortem-on-august-6-2026-metabase-security-incident)
- **Uptime snapshot (status page, read 2026-10-03, 90-day window):**
  - APIs 99.90%
  - Webhooks 99.97%
  - Wallet transactions 100.0%
  - SDKs 100.0%

  Source: [status.privy.io](https://status.privy.io)
- **SLA:** Enterprise lists "Premium SLAs and dedicated support". No public SLA figure for Developer plans. — [Pricing](https://www.privy.io/pricing)
- **Stripe ownership** ([About](https://www.privy.io/about), [SOC 2 post](https://www.privy.io/blog/privy-renews-soc-2-type-ii-compliance)):
  - The about page says: "As a Stripe company, Privy offers the same world-class benefits…".
  - The legal entity in site footers is Horkos, Inc.
  - Blog posts show Stripe integrations: Stripe Projects, Stripe Sessions, Stripe Terminal, the Stripe embedded onramp recipe ([Privy blog index](https://www.privy.io/blog)).
  - The acquisition announcement date (June 2025) is from memory **[unverified]**. I could not fetch the Stripe or Privy announcement this session.
- **Key-material recovery:** Privy never sees the app authorization private key and "cannot help you recover it". — [Configure signers](https://docs.privy.io/wallets/using-wallets/signers/configure-signers)

### Inferences
- **Our real attack surface is the authorization key plus app secret.** Mitigations:
  - KMS-backed custom signer, so the key is never exported to the app.
  - IP allowlist.
  - Short request expiry.
  - Restrictive override policy whose owner is a separate cold quorum.
  - A separate internal signing service that enforces per-user rate and size limits Privy can't enforce on Solana.
  - Alerting on policy-denied requests.
- **Be upfront with users:** they can always export (good for trust and for Axiom parity). Our app can trade but, with the policy above, cannot withdraw. Users can revoke at any time.

### Gaps
- No public numeric SLA, and no regional failover detail for the signing path.
- No info on what happens to delegated signing during a Privy outage. Presumably trades fail closed, which is a business-continuity risk for a terminal. Ask Privy about enterprise failover.
- I found no published Stripe-driven changes to Privy pricing or terms beyond the insurance note.

---

## 6. Pricing (2026) and cost at 1,000 / 10,000 active users × 50 trades/day

### Takeaway
The free tier allows **50K signatures and $1M transaction volume** per month. MAU tiers are free (<500), $299/mo (500–2,499) and $499/mo (2,500–9,999). **Above 10K MAU or 50K signatures, PAYG applies:** a $2,000 base fee, plus $0.05 per MAU above 10K, plus **$0.01 per signature above 50K**. Enterprise offers signature pricing "as low as $0.001/signature".

At about 1,500 signatures per user per month, signatures dominate the bill:
- **PAYG:** about $15–16.50 per user per month.
- **Enterprise at $0.001/sig:** about $1.50 per user per month plus whatever platform fee is negotiated.

### Cited Findings
- **Plans** ([Pricing](https://www.privy.io/pricing), fetched 2026-10-03):
  - "Developer… 50K signatures and $1M transaction volume for free every month."
  - Free: 0–499 MAU. Core: 500–2,499 MAU at $299/mo. Scale: 2,500–9,999 MAU at $499/mo.
- **PAYG:** "If your usage exceeds 10,000 MAU or 50,000 signatures in a given month, pay-as-you-go pricing for additional usage will apply: a volume PAYG base fee of $2,000; $0.05 per MAU above 10,000 MAUs; and $0.01 per signature above 50,000 signatures." Also: "Apps exceeding 10K MAU, 50K monthly signatures, or $1M monthly transaction volume are billed based on usage." — [Pricing](https://www.privy.io/pricing)
- **Enterprise:** "Custom pricing per transaction or transacting wallet", "Signature-based pricing as low as $0.001/signature", "Premium SLAs". Enterprise is "typically cheaper and more predictable than monthly PAYG". — [Pricing](https://www.privy.io/pricing)
- **What counts as a signature:** "any cryptographic signature request from a Privy embedded wallet". The list includes `signTransaction` and `signAndSendTransaction`. — [Pricing](https://www.privy.io/pricing)
- **What counts as an MAU:** "any Privy-authenticated user with at least one active session in the last 30 days". If you cancel a paid plan and are already over 500 MAU, "new users will no longer be able to sign up". — [Pricing](https://www.privy.io/pricing)
- The feature matrix shows "Delegated access to wallets", "Policy engine", "Key quorum approvals" and "Multi-wallet accounts" in all plans. Webhooks and SSO are Enterprise. — [Pricing](https://www.privy.io/pricing)

### Cost estimate (my arithmetic; assumes 1 signature per trade, 30-day month, list prices)
| Scenario | Signatures/mo | PAYG list price | Per user/mo (PAYG) | Enterprise @ $0.001/sig (signature part only) |
|---|---|---|---|---|
| 1,000 users × 50 trades/day | 1.5M | $2,000 + (1.5M − 50K) × $0.01 = **$16,500** | **$16.50** | ~$1,500 (+ unknown platform fee) → ~$1.50/user |
| 10,000 users × 50 trades/day | 15M | $2,000 + (15M − 50K) × $0.01 = **$151,500** (+ $0.05 per MAU above 10,000) | **~$15.15** | ~$15,000 (+ platform fee) → ~$1.50/user |

### Inferences
- For a "zero-fee" terminal, PAYG at about $15–16.50 per active user per month is significant. **Negotiate Enterprise before launch.** At $0.001/sig the cost falls about 10×.
- Avoid unnecessary signatures:
  - Don't sign multiple transaction variants per trade unless required, e.g. separate Jito-bundle and Sender versions.
  - Don't re-sign on retries. Rebroadcast the same bytes.
  - Avoid `signMessage` calls for auth.
- Each re-sign after blockhash expiry or a priority-fee bump is another billable signature.
- The "$1M monthly transaction volume" trigger is very likely to be exceeded by a memecoin terminal. The site gives **no published rate** for volume-based billing, so confirm whether volume adds charges beyond signatures.

### Gaps
- Unclear whether the $299/$499 tier fees stack with the $2,000 PAYG base. The FAQ wording suggests PAYG replaces them.
- No published per-volume fee.
- Enterprise platform minimums are not public.

---

## 7. Solana specifics: versioned transactions, ALTs, durable nonces, multiple wallets, key import

### Takeaway
What is supported:
- **Versioned (v0) transactions:** signed as base64.
- **ALTs:** sign fine, but break *address-based* policy conditions on ALT-loaded accounts.
- **Multiple wallets per user:** HD wallets via `createWallet({createAdditional: true})`, path `m/44'/501'/i/0'`. No documented maximum.
- **Importing an existing Solana private key:** `useImportWallet` from `@privy-io/react-auth/solana`, base58.

Durable nonce support is not documented.

### Cited Findings
- **Versioned transactions:** Node examples build a `VersionedTransaction(message.compileToV0Message())` and pass `Buffer.from(tx.serialize()).toString('base64')` to `signTransaction`/`signAndSendTransaction`. Only `base64` encoding. — [Sign a transaction (Solana)](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction), [Send a transaction](https://docs.privy.io/wallets/using-wallets/solana/send-a-transaction)
- **ALTs:** see Section 3. Rejection happens only when a policy needs to inspect an ALT-loaded address. — [Solana examples](https://docs.privy.io/controls/policies/example-policies/solana)
- **HD wallets:** "Privy embedded wallets are hierarchical deterministic (HD) wallets… Privy can be used to provision multiple embedded wallets for a single user." The Solana path is `m/44'/501'/i/0'`. Call `createWallet` with `createAdditional: true` for more. — [HD wallets](https://docs.privy.io/recipes/hd-wallets), [Create a wallet](https://docs.privy.io/wallets/wallets/create/create-a-wallet)
- **MFA across wallets:** MFA enrollment applies to all of a user's wallets, including multiple HD addresses. — [MFA overview](https://docs.privy.io/authentication/user-authentication/mfa/overview)
- **Import:** `importWallet({privateKey})`, where the key is "The base58-encoded private key of the solana wallet to import." Server SDKs also import, with HPKE encryption to the TEE. "Imported wallets function the same way as Privy-generated wallets." — [Import private key](https://docs.privy.io/wallets/wallets/import-a-wallet/private-key)
- **Export:** "Key export is available for all wallets on every supported tier." — [Export a wallet](https://docs.privy.io/wallets/wallets/export)
- **Gas sponsorship:** `sponsor: true` exists on `signAndSendTransaction`. Not needed if users pay their own fees and tips. — [Send a transaction](https://docs.privy.io/wallets/using-wallets/solana/send-a-transaction)

### Inferences
- **Multi-wallet (Axiom's 25):** create HD wallets 1..N on demand. **Each new wallet needs its own signer grant.** Pass `signers` in `createWallet`, or call `addSigners` per address. Our backend tracks `wallet.id` for each address.
- **Imported wallets** also need `addSigners` before the backend can trade them.
- **Durable nonces:** `signTransaction` signs arbitrary serialized bytes, so a nonce-based transaction should sign as long as the policy allows the leading `AdvanceNonceAccount` System instruction. That instruction would need an explicit ALLOW rule, and support for that `instructionName` value is unverified.

### Gaps
- No documented maximum number of HD wallets per user.
- No explicit durable-nonce documentation or examples.
- Not documented whether `exportWallet` exports a specific HD index or all of them (the export page shows no address param in the snippet I read).

---

## Implications for the build

**Recommended architecture**
1. **Frontend (React):**
   - `@privy-io/react-auth` 3.x. Login: email OTP, Google, X, Telegram, passkey, and Phantom/SIWS.
   - Strongly prompt passkey/TOTP MFA.
   - On first login, create the Solana embedded wallet and grant our signer in one step: `useCreateWallet` from `@privy-io/react-auth/solana` → `createWallet({signers:[{signerId: KEY_QUORUM_ID, policyIds:[TRADING_POLICY_ID]}]})`. If using the Privy modal, use `createOnLogin` + `addSigners` instead.
   - Add a "Revoke trading access" button (`removeSigners`) and an "Export key" button (`useExportWallet`).
   - Withdrawals are signed by the user client-side; the app signer can't do them.
2. **Backend (Bun):**
   - `@privy-io/node` 0.35.x. Verify JWTs locally with `jwtVerificationKey`.
   - An isolated **signing service** holds the P-256 authorization key in KMS via the custom-sign-function authorization context.
   - That service enforces our own per-user caps and rate limits, then calls `privy.wallets().solana().signTransaction(walletId, {transaction, authorization_context})`.
   - Set `privy-request-expiry` on every call and turn on the IP allowlist.
3. **Submission:** take the returned signed bytes and broadcast them ourselves, in parallel, through Helius Sender and Jito. Never re-sign to retry. Optionally A/B test `signAndSendTransaction` + `optimistic_broadcast` + `x-privy-skip-simulation: true` to add Privy's FullSend path.
4. **Governance:** the trading policy's **owner** is a separate multi-party key quorum held offline. The hot server key can sign trades but cannot change policy.

**Default policy to enforce**
- Rules on method `signTransaction` only. ALLOW top-level instructions only from: ComputeBudget, pump.fun, PumpSwap, Raydium (AMM v4/CPMM/CLMM/LaunchLab), Jupiter v6, and the ATA program.
- ALLOW System `Transfer` only to Jito/Helius tip accounts (static keys), `Transfer.lamports ≤ 0.05 SOL`.
- ALLOW Token `CloseAccount`/`InitializeAccount3`.
- Optional IDL-based per-trade SOL cap on pump.fun/PumpSwap buy args.
- DENY `exportPrivateKey`. No `signMessage` rule.
- Result: arbitrary SOL/SPL withdrawals by the backend are impossible.
- Handle WSOL wrapping with either a per-wallet policy (user's WSOL ATA in the `Transfer.to` allowlist) or CPI-based wrapping. Verify every program ID and test on devnet.

**Expected latency added per trade**
- About 70–95 ms median for the Privy sign round trip. That is 72 ms Privy-measured with the proxy bypass and about 92 ms without, plus our backend-to-Privy network distance.
- Co-locate in Privy's nearest AWS region and request the proxy bypass.
- Get rate limits in writing; they are unpublished.

**Expected cost per user**
- At 50 trades/day ≈ 1,500 signatures/user/month:
  - **PAYG list price:** about $16.50/user/month at 1K users ($16.5K/mo) and about $15.15/user/month at 10K users ($151.5K/mo).
  - **Enterprise at $0.001/sig:** about $1.50/user/month plus a negotiated platform fee.
- Negotiate Enterprise, and confirm whether the $1M/month transaction-volume trigger adds separate charges, before launch.
