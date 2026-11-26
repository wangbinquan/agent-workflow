// RFC-605 — an opaque identity token for cross-module contracts (RFC-294 design §3.3: a branded handle).
//
// The implementation that owns a namespace mints one token per thing it hands out and keys its own state by the token's
// identity (a `WeakMap`, or `===`); consumers only carry it and hand it back. The brand exists only in the type: it makes
// tokens nominal per tag, so a token minted for one purpose cannot be passed where another is expected. At runtime a
// token is a frozen empty object, exactly the identity the former `{}` literals gave.
declare const opaqueIdentityBrand: unique symbol

export type OpaqueIdentity<Tag extends string> = { readonly [opaqueIdentityBrand]: Tag }

export function mintOpaqueIdentity<Tag extends string>(): OpaqueIdentity<Tag> {
  return Object.freeze({}) as OpaqueIdentity<Tag>
}
