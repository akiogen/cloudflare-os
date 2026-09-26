// Test-only stand-in for Cloudflare Email Routing (see wrangler.jsonc). `POST /deliver?to=<local
// part>` with a JSON IncomingEmail body delivers it to that mailbox's hook, exactly as
// gatekeeper-email's email() handler does after parsing the raw message.

type IncomingEmail = Record<string, unknown>;
type EmailAddressStub = { receiveEmail(email: IncomingEmail): Promise<void> };
type Env = { EMAIL_ADDRESS: { getByName(name: string): EmailAddressStub } };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const to = url.searchParams.get("to");
    if (url.pathname !== "/deliver" || request.method !== "POST" || to === null) {
      return new Response(null, { status: 404 });
    }
    const email = (await request.json()) as IncomingEmail;
    try {
      await env.EMAIL_ADDRESS.getByName(to).receiveEmail({ ...email, attachments: [] });
      return new Response(null, { status: 204 });
    } catch (error) {
      return new Response(String(error), { status: 500 });
    }
  },
};
