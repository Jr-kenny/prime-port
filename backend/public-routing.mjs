// The only public route that reaches the port service is an exact,
// content-addressed attachment download. Port control stays internal.
export function publicUpstream(path, method) {
  if (
    path === "/mcp"
    || path === "/mcp/publish"
    || path.startsWith("/auth")
    || path.startsWith("/jobs")
    || path.startsWith("/freelancers")
    || path.startsWith("/evidence")
  ) return 8792;
  if (method === "GET" && /^\/attachments\/[\w.-]+\/[0-9a-f]{64}$/.test(path)) return 8791;
  return null;
}
