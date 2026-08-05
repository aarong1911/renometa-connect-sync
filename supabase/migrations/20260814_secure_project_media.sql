-- ============================================================================
-- 2. PROJECT-MEDIA STORAGE POLICIES
-- ============================================================================

-- Exact required path:
-- organizations/{orgId}/projects/{projectId}/photos/{photoId}/{fileName}
--
-- Authorization validates:
-- 1. the user belongs to the organization;
-- 2. path segment 2 is that organization;
-- 3. path segment 4 is a Project belonging to that same organization;
-- 4. write operations target the photos section.

-- Remove both previous naming conventions so permissive duplicate policies
-- cannot accidentally broaden access.
drop policy if exists "Org members can read project-media"
  on storage.objects;
drop policy if exists "Org members can upload project-media"
  on storage.objects;
drop policy if exists "Org members can update project-media"
  on storage.objects;
drop policy if exists "Org members can delete project-media"
  on storage.objects;

drop policy if exists "Org members can view project media"
  on storage.objects;
drop policy if exists "Org members can upload project media"
  on storage.objects;
drop policy if exists "Org members can update project media"
  on storage.objects;
drop policy if exists "Org members can delete project media"
  on storage.objects;

create policy "Org members can view project media"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'project-media'
    and (storage.foldername(storage.objects.name))[1] = 'organizations'
    and (storage.foldername(storage.objects.name))[3] = 'projects'
    and exists (
      select 1
      from public.projects p
      where p.id::text =
        (storage.foldername(storage.objects.name))[4]
        and p.org_id::text =
        (storage.foldername(storage.objects.name))[2]
        and (
          p.org_id in (
            select pr.organization_id
            from public.profiles pr
            where pr.id = auth.uid()
          )
          or p.org_id in (
            select om.org_id
            from public.org_memberships om
            where om.member_id = auth.uid()
          )
        )
    )
  );

create policy "Org members can upload project media"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'project-media'
    and (storage.foldername(storage.objects.name))[1] = 'organizations'
    and (storage.foldername(storage.objects.name))[3] = 'projects'
    and (storage.foldername(storage.objects.name))[5] = 'photos'
    and nullif(
      (storage.foldername(storage.objects.name))[6],
      ''
    ) is not null
    and exists (
      select 1
      from public.projects p
      where p.id::text =
        (storage.foldername(storage.objects.name))[4]
        and p.org_id::text =
        (storage.foldername(storage.objects.name))[2]
        and (
          p.org_id in (
            select pr.organization_id
            from public.profiles pr
            where pr.id = auth.uid()
          )
          or p.org_id in (
            select om.org_id
            from public.org_memberships om
            where om.member_id = auth.uid()
          )
        )
    )
  );

create policy "Org members can update project media"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'project-media'
    and (storage.foldername(storage.objects.name))[1] = 'organizations'
    and (storage.foldername(storage.objects.name))[3] = 'projects'
    and (storage.foldername(storage.objects.name))[5] = 'photos'
    and nullif(
      (storage.foldername(storage.objects.name))[6],
      ''
    ) is not null
    and exists (
      select 1
      from public.projects p
      where p.id::text =
        (storage.foldername(storage.objects.name))[4]
        and p.org_id::text =
        (storage.foldername(storage.objects.name))[2]
        and (
          p.org_id in (
            select pr.organization_id
            from public.profiles pr
            where pr.id = auth.uid()
          )
          or p.org_id in (
            select om.org_id
            from public.org_memberships om
            where om.member_id = auth.uid()
          )
        )
    )
  )
  with check (
    bucket_id = 'project-media'
    and (storage.foldername(storage.objects.name))[1] = 'organizations'
    and (storage.foldername(storage.objects.name))[3] = 'projects'
    and (storage.foldername(storage.objects.name))[5] = 'photos'
    and nullif(
      (storage.foldername(storage.objects.name))[6],
      ''
    ) is not null
    and exists (
      select 1
      from public.projects p
      where p.id::text =
        (storage.foldername(storage.objects.name))[4]
        and p.org_id::text =
        (storage.foldername(storage.objects.name))[2]
        and (
          p.org_id in (
            select pr.organization_id
            from public.profiles pr
            where pr.id = auth.uid()
          )
          or p.org_id in (
            select om.org_id
            from public.org_memberships om
            where om.member_id = auth.uid()
          )
        )
    )
  );

create policy "Org members can delete project media"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'project-media'
    and (storage.foldername(storage.objects.name))[1] = 'organizations'
    and (storage.foldername(storage.objects.name))[3] = 'projects'
    and (storage.foldername(storage.objects.name))[5] = 'photos'
    and nullif(
      (storage.foldername(storage.objects.name))[6],
      ''
    ) is not null
    and exists (
      select 1
      from public.projects p
      where p.id::text =
        (storage.foldername(storage.objects.name))[4]
        and p.org_id::text =
        (storage.foldername(storage.objects.name))[2]
        and (
          p.org_id in (
            select pr.organization_id
            from public.profiles pr
            where pr.id = auth.uid()
          )
          or p.org_id in (
            select om.org_id
            from public.org_memberships om
            where om.member_id = auth.uid()
          )
        )
    )
  );