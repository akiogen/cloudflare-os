// business-loop-os ADR-0010 / #54: public Context collections are deployment-wide, so every Tenant
// reads them. Only admins (the Provider's ADMINS) may create or change one; a non-admin is refused
// before any collection is touched, exactly as for a collection that does not exist.

import { describe, expect, it } from "vitest";
import { ContextApiImpl } from "../src/context-api.js";

type Namespace<T extends Rpc.DurableObjectBranded | undefined = undefined> =
    DurableObjectNamespace<T>;
type Args = ConstructorParameters<typeof ContextApiImpl>;

const DOMAIN = "default";
const PUBLIC_ID = "public-guide";
const NOT_FOUND = "Collection not found or you don't have access.";

/**
 * ContextApiImpl over stand-in namespaces: one public collection (PUBLIC_ID) in the domain registry,
 * an account that owns no private collection, and collection objects that record every call.
 */
function contextApi(isAdmin: boolean) {
  const touched: string[] = [];
  const collection = new Proxy({}, {
    get: (_target, method: string) => async (...args: unknown[]) => {
      touched.push(method);
      return method === "initialize" ? args[0] : undefined;
    },
  });
  const collections = { idFromName: (name: string) => name, get: () => collection };
  const userLibraries = {
    idFromName: (name: string) => name,
    get: () => ({ hasOwned: async () => false, createOwnedCollection: async () => {} }),
  };
  const registries = {
    getByName: () => ({
      isPublic: async (id: string) => id === PUBLIC_ID,
      addPublic: async () => { touched.push("addPublic"); },
    }),
  };
  const api = new ContextApiImpl(
      {} as Args[0], DOMAIN, "account-1", isAdmin,
      collections as unknown as Namespace as Args[4],
      userLibraries as unknown as Namespace as Args[5],
      registries as unknown as Namespace as Args[6]);
  return { api, touched };
}

/** Every ContextApi write on an existing collection, applied to `id`. */
function writes(api: ContextApiImpl, id: string): [string, () => Promise<unknown>][] {
  return [
    ["updateContextCollection", () => api.updateContextCollection(id, { title: "Changed" })],
    ["deleteContextCollection", () => api.deleteContextCollection(id)],
    ["putContextDocument",
      () => api.putContextDocument(id, "guide.md", { description: "d", body: "b" })],
    ["deleteContextDocument", () => api.deleteContextDocument(id, "guide.md")],
    ["moveContextDocument", () => api.moveContextDocument(id, "guide.md", "moved.md")],
    ["syncContextCollectionArtifactSource", () => api.syncContextCollectionArtifactSource(id)],
    ["createContextCollectionGitToken", () => api.createContextCollectionGitToken(id)],
    ["listContextCollectionGitTokens", () => api.listContextCollectionGitTokens(id)],
    ["revokeContextCollectionGitToken", () => api.revokeContextCollectionGitToken(id, "token")],
  ];
}

describe("public Context collections for a non-admin", () => {
  it("cannot create one", async () => {
    const { api, touched } = contextApi(false);
    await expect(api.createContextCollection("Guide", "d", "public"))
        .rejects.toThrow("Admin access required.");
    expect(touched).toEqual([]);
  });

  it("cannot change an existing one, and is told it does not exist", async () => {
    const { api, touched } = contextApi(false);
    for (const [name, write] of writes(api, PUBLIC_ID)) {
      await expect(write(), name).rejects.toThrow(NOT_FOUND);
    }
    expect(await api.canWriteContextCollection(PUBLIC_ID)).toBe(false);
    expect(touched).toEqual([]);
  });

  it("can still create a private one", async () => {
    const { api, touched } = contextApi(false);
    await api.createContextCollection("Mine", "d", "private");
    expect(touched).toEqual(["initialize"]);
  });
});

describe("public Context collections for an admin", () => {
  it("can create and change one", async () => {
    const { api, touched } = contextApi(true);
    await api.createContextCollection("Guide", "d", "public");
    expect(touched).toEqual(["initialize", "addPublic"]);
    await api.putContextDocument(PUBLIC_ID, "guide.md", { description: "d", body: "b" });
    expect(await api.canWriteContextCollection(PUBLIC_ID)).toBe(true);
    expect(touched).toContain("putContextDocument");
  });
});
