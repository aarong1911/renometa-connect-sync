# Stage 2 — Global UI Foundation

This stage updates the shared presentation layer while preserving routing, Supabase, authentication, permissions, dialogs, and page-specific business logic.

## Updated

- Warm neutral canvas and sidebar palette aligned with the approved RenoMeta direction.
- More restrained primary blue with gold available as an intentional accent.
- Responsive application content gutters and a consistent 1600px maximum content width.
- Responsive page headers whose actions wrap correctly on narrower screens.
- Refined sticky topbar with a card-style global search field and improved compact behavior.
- Unified button geometry, focus states, shadows, and an optional `gold` variant.
- Unified cards with lighter borders and subtle elevation.
- Unified inputs with improved focus and hover treatment.
- Cleaner table headers, row spacing, and hover states.
- New shared `PageContainer`, `SectionCard`, and `SectionLink` primitives.

## New shared component

`src/components/ui/page-layout.tsx`

Use this for pages migrated during later stages:

```tsx
<PageContainer>
  <PageHeader ... />
  <SectionCard title="Recent activity" icon={Activity}>
    ...
  </SectionCard>
</PageContainer>
```

## Validation note

A full local build could not be completed in the artifact environment because dependency installation exceeded the execution window. No package dependencies were added or removed. Run locally:

```bash
npm install
npm run build
```
