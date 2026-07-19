---
name: tanstack-router-guards
description: >
  Patterns for TanStack Router file-based routing — createFileRoute conventions,
  route guards, permission-based redirects, and role-aware navigation. Use whenever
  working with TanStack Router routes, adding new pages, implementing auth guards,
  role-based access control, or fixing route type errors. Also triggers for
  "createFileRoute", "FileRoutesByPath", routeTree.gen.ts errors, or any
  navigation/redirect logic.
---

# TanStack Router — File-based Routing & Guards

## File Naming → Route Mapping

| File | Route |
|---|---|
| `src/routes/index.tsx` | `/` |
| `src/routes/projects.index.tsx` | `/projects/` |
| `src/routes/settings.tsx` | `/settings` (layout) |
| `src/routes/settings.permissions.tsx` | `/settings/permissions` |
| `src/routes/portal.tsx` | `/portal` |

## createFileRoute — Correct Usage

```typescript
// CORRECT — string literal, no cast
export const Route = createFileRoute("/settings/permissions")({ component: Page });

// WRONG — breaks router generator
export const Route = createFileRoute("/settings/permissions" as any)({ component: Page });
```

If you see `not assignable to keyof FileRoutesByPath`:
Run `pnpm dev` — plugin auto-adds route to `routeTree.gen.ts`. Never add `as any`.

Find bad casts (PowerShell):
```powershell
Select-String -Path "src/routes/*.tsx" -Pattern "createFileRoute.*as any"
```

## Auth + Role Guard (__root.tsx)

```typescript
const PUBLIC_ROUTES = ["/signin", "/signup", "/forgot-password", "/auth/callback"];
const PORTAL_ROUTES = ["/portal"];

// Auth redirect
if (!session && !isPublicRoute && !isPortalRoute) navigate({ to: "/signin" });

// Role guard — runs inside AppShell
function RoleGuard({ pathname, session, children }) {
  const role = useCurrentUserRole(); // src/lib/permissions.ts
  useEffect(() => {
    if (!session || !role) return;
    const external = ROLE_EXTERNAL_REDIRECT[role];
    if (external) { window.location.href = external; return; }
    if (!canAccessRoute(role, pathname)) navigate({ to: ROLE_DEFAULT_ROUTE[role] ?? "/" });
  }, [role, pathname]);
  if (role && !canAccessRoute(role, pathname)) return <Spinner />;
  return <>{children}</>;
}
```

## Sidebar — Role Filtering

```typescript
// Wait for role before rendering nav items — prevents full sidebar flash on login
const groups = role === null ? [] : filterNavGroups(ALL_GROUPS, role);
const showSettings = role === null ? false : canAccessSettings(role); // owner only
```

## Permission System (src/lib/permissions.ts)

```typescript
canAccessRoute(role, pathname): boolean   // check route access
filterNavGroups(groups, role): groups     // filter sidebar items
canAccessSettings(role): boolean          // owner only
useCurrentUserRole(): Role | null         // hook — finds user in team store
```

Automation routes: `/automation` (prefix covers `/automation/workflows`, `/automation/agents`, `/automation/triggers`)

## Adding a New Route

1. Create `src/routes/my-page.tsx`
2. Add `export const Route = createFileRoute("/my-page")({ component: MyPage })`
3. Run `pnpm dev` — router plugin auto-updates `routeTree.gen.ts`
4. Add to `ROLE_ALLOWED_ROUTES` in `permissions.ts`
5. Add nav item to `sidebar.tsx` `ALL_GROUPS` if needed

## Common Errors

| Error | Cause | Fix |
|---|---|---|
| `expected route id to be a string literal` | `as any` cast | Remove it, run pnpm dev |
| `not assignable to keyof FileRoutesByPath` | routeTree not regenerated | Run pnpm dev |
| Portal renders with AppShell | Missing portal exclusion | Add to `PORTAL_ROUTES` in __root.tsx |
| Role guard flash on login | Sidebar renders before role loads | Return `[]` when role is null |