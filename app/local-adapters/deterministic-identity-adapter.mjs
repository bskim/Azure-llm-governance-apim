export function createDeterministicIdentityAdapter(verifiedIdentity) {
  const fixedIdentity = structuredClone(verifiedIdentity);
  return Object.freeze({
    async getVerifiedIdentity() {
      return structuredClone(fixedIdentity);
    },
  });
}