/**
 * The scope every MCP tool call runs in (team/projects spec D15): identity -> scope -> authorization -> domain service.
 * Today there is exactly one scope, the authenticated user's personal workspace. The scope is built from the
 * authenticated identity by the route, never from tool input, so a tool argument cannot widen it. Project scopes are
 * added with the project work and are deliberately not representable here yet.
 */
export type McpScope = { readonly kind: 'personal'; readonly userId: string };

export const personalScope = (userId: string): McpScope => ({ kind: 'personal', userId });
