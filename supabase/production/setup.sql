-- Central licensing tables for a Supabase project shared with PharmaCare.
-- All licensing records use central_* names to avoid colliding with app tables.

create table if not exists public.central_shops (
  id uuid primary key default gen_random_uuid(),
  shop_code text unique not null,
  shop_name text not null,
  owner_email text,
  owner_phone text,
  status text not null default 'PENDING_ACTIVATION',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.central_licenses (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.central_shops(id) on delete cascade,
  license_key text unique not null,
  license_type text not null default 'TRIAL',
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  grace_days integer not null default 30,
  max_devices integer not null default 1,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  warning_days integer not null default 14,
  enabled_pages text[] not null default array[
    'pos', 'products', 'categories', 'suppliers', 'customers', 'sales_history',
    'purchase_history', 'purchases', 'expenses', 'stock_inventory', 'reports',
    'manage_users', 'settings'
  ]::text[],
  enabled_features text[] not null default array[
    'pos_print_sale', 'pos_print_payment', 'settings_shop_profile',
    'settings_receipt_memo', 'settings_receipt_qr', 'settings_operations',
    'settings_demo_data', 'settings_whatsapp_templates'
  ]::text[],
  created_at timestamptz not null default now()
);

alter table public.central_licenses
  add column if not exists status text not null default 'ACTIVE';

alter table public.central_licenses
  add column if not exists enabled_pages text[] not null default array[
    'pos', 'products', 'categories', 'suppliers', 'customers', 'sales_history',
    'purchase_history', 'purchases', 'expenses', 'stock_inventory', 'reports',
    'manage_users', 'settings'
  ]::text[],
  add column if not exists enabled_features text[] not null default array[
    'pos_print_sale', 'pos_print_payment', 'settings_shop_profile',
    'settings_receipt_memo', 'settings_receipt_qr', 'settings_operations',
    'settings_demo_data', 'settings_whatsapp_templates'
  ]::text[];

alter table public.central_licenses
  add column if not exists grace_days integer not null default 30,
  add column if not exists warning_days integer not null default 14;

update public.central_licenses
set warning_days = least(warning_days, grace_days)
where warning_days > grace_days;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'central_licenses_grace_days_valid'
  ) then
    alter table public.central_licenses add constraint central_licenses_grace_days_valid
      check (grace_days between 1 and 365);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'central_licenses_warning_days_valid'
  ) then
    alter table public.central_licenses add constraint central_licenses_warning_days_valid
      check (warning_days between 1 and grace_days);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'central_licenses_enabled_pages_valid'
  ) then
    alter table public.central_licenses add constraint central_licenses_enabled_pages_valid check (
      enabled_pages <@ array[
        'pos', 'products', 'categories', 'suppliers', 'customers', 'sales_history',
        'purchase_history', 'purchases', 'expenses', 'stock_inventory', 'reports',
        'manage_users', 'settings'
      ]::text[]
    );
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'central_licenses_enabled_features_valid'
  ) then
    alter table public.central_licenses add constraint central_licenses_enabled_features_valid check (
      enabled_features <@ array[
        'pos_print_sale', 'pos_print_payment', 'settings_shop_profile',
        'settings_receipt_memo', 'settings_receipt_qr', 'settings_operations',
        'settings_demo_data', 'settings_whatsapp_templates'
      ]::text[]
    );
  end if;
end;
$$;

create unique index if not exists central_licenses_one_per_shop_idx
  on public.central_licenses(shop_id);

create table if not exists public.central_developer_owners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.central_shop_activations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.central_shops(id) on delete cascade,
  activation_code_hash text unique not null,
  admin_username text,
  is_used boolean not null default false,
  used_at timestamptz,
  expires_at timestamptz not null,
  installation_fingerprint text
);

create index if not exists central_shop_activations_device_lookup_idx
  on public.central_shop_activations(shop_id, is_used, installation_fingerprint);

create table if not exists public.central_shop_checkins (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.central_shops(id) on delete cascade,
  app_version text,
  os_version text,
  admin_setup_complete boolean not null default false,
  checkin_ip text,
  checkin_time timestamptz not null default now()
);

create index if not exists central_shop_checkins_recent_idx
  on public.central_shop_checkins(shop_id, checkin_time desc);

alter table public.central_shop_checkins
  add column if not exists admin_setup_complete boolean not null default false;

create or replace view public.central_latest_shop_checkins as
select distinct on (shop_id)
  shop_id, app_version, os_version, admin_setup_complete, checkin_time
from public.central_shop_checkins
order by shop_id, checkin_time desc;

create table if not exists public.central_shop_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  body text not null check (char_length(body) between 1 and 2000),
  target_shop_ids uuid[] not null default '{}'::uuid[],
  is_global boolean not null default false,
  is_published boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  check (is_global or cardinality(target_shop_ids) > 0)
);

create index if not exists central_shop_announcements_published_idx
  on public.central_shop_announcements(is_published, published_at desc);

create table if not exists public.central_software_versions (
  id uuid primary key default gen_random_uuid(),
  version text unique not null,
  release_date timestamptz not null default now(),
  min_supported_version text,
  release_notes text,
  installer_url text,
  installer_sha256 text,
  is_mandatory boolean not null default false
);

create table if not exists public.central_admin_password_resets (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.central_shops(id) on delete cascade,
  reset_token_hash text not null,
  is_used boolean not null default false,
  expires_at timestamptz not null
);

create index if not exists central_admin_password_resets_active_idx
  on public.central_admin_password_resets(shop_id, expires_at)
  where is_used = false;

create or replace function public.central_create_shop(
  p_shop_code text,
  p_shop_name text,
  p_owner_email text,
  p_owner_phone text,
  p_license_key text,
  p_license_type text,
  p_license_expires_at timestamptz,
  p_grace_days integer,
  p_warning_days integer,
  p_enabled_pages text[],
  p_enabled_features text[],
  p_activation_code_hash text,
  p_activation_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  created_shop public.central_shops%rowtype;
  activation_id uuid;
begin
  if p_shop_name is null or char_length(trim(p_shop_name)) not between 1 and 160
    or p_activation_code_hash is null or p_activation_code_hash !~ '^[0-9a-f]{64}$'
    or p_activation_expires_at is null or p_activation_expires_at <= now()
    or p_grace_days not between 1 and 365
    or p_warning_days not between 1 and p_grace_days then
    raise exception 'Invalid pharmacy license setup.';
  end if;

  insert into public.central_shops (
    shop_code, shop_name, owner_email, owner_phone, status
  ) values (
    p_shop_code, trim(p_shop_name), nullif(trim(p_owner_email), ''),
    nullif(trim(p_owner_phone), ''), 'PENDING_ACTIVATION'
  ) returning * into created_shop;

  insert into public.central_licenses (
    shop_id, license_key, license_type, expires_at, status,
    enabled_pages, enabled_features, grace_days, warning_days
  ) values (
    created_shop.id, p_license_key, coalesce(nullif(trim(p_license_type), ''), 'STANDARD'),
    p_license_expires_at, 'ACTIVE', p_enabled_pages, p_enabled_features,
    p_grace_days, p_warning_days
  );

  insert into public.central_shop_activations (
    shop_id, activation_code_hash, expires_at
  ) values (
    created_shop.id, p_activation_code_hash, p_activation_expires_at
  ) returning id into activation_id;

  return jsonb_build_object(
    'shop', to_jsonb(created_shop),
    'activationId', activation_id
  );
end;
$$;

alter table public.central_shops enable row level security;
alter table public.central_licenses enable row level security;
alter table public.central_shop_activations enable row level security;
alter table public.central_shop_checkins enable row level security;
alter table public.central_developer_owners enable row level security;
alter table public.central_software_versions enable row level security;
alter table public.central_admin_password_resets enable row level security;
alter table public.central_shop_announcements enable row level security;

revoke all on public.central_shops, public.central_licenses, public.central_shop_activations,
  public.central_shop_checkins, public.central_developer_owners, public.central_software_versions,
  public.central_admin_password_resets, public.central_shop_announcements from public, anon, authenticated;
grant all on public.central_shops, public.central_licenses, public.central_shop_activations,
  public.central_shop_checkins, public.central_developer_owners, public.central_software_versions,
  public.central_admin_password_resets, public.central_shop_announcements to service_role;
revoke all on public.central_latest_shop_checkins from public, anon, authenticated;
grant select on public.central_latest_shop_checkins to service_role;

create or replace function public.central_consume_shop_activation(
  p_activation_hash text,
  p_hardware_fingerprint text
)
returns table (shop_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed_shop_id uuid;
begin
  update public.central_shop_activations activation
  set is_used = true,
      used_at = now(),
      installation_fingerprint = p_hardware_fingerprint
  where activation.activation_code_hash = p_activation_hash
    and activation.is_used = false
    and activation.expires_at > now()
    and exists (
      select 1
      from public.central_shops shop
      join public.central_licenses license on license.shop_id = shop.id
      where shop.id = activation.shop_id
        and shop.status in ('PENDING_ACTIVATION', 'ACTIVE')
        and license.status = 'ACTIVE'
        and license.starts_at <= now()
        and (license.expires_at is null or license.expires_at > now())
    )
  returning activation.shop_id into claimed_shop_id;

  if claimed_shop_id is null then
    return;
  end if;

  update public.central_shops
  set status = 'ACTIVE', updated_at = now()
  where id = claimed_shop_id;

  return query select claimed_shop_id;
end;
$$;

create or replace function public.central_reissue_shop_activation(
  p_shop_id uuid,
  p_activation_hash text,
  p_expires_at timestamptz
)
returns table (id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_activation_id uuid;
begin
  if p_activation_hash is null or p_activation_hash !~ '^[0-9a-f]{64}$'
    or p_expires_at is null or p_expires_at <= now() then
    raise exception 'A valid activation hash and future expiry are required.';
  end if;

  perform 1
  from public.central_shops shop
  join public.central_licenses license on license.shop_id = shop.id
  where shop.id = p_shop_id
    and shop.status = 'ACTIVE'
    and license.status = 'ACTIVE'
    and license.starts_at <= now()
    and (license.expires_at is null or license.expires_at > now())
  for update of shop, license;

  if not found then
    return;
  end if;

  delete from public.central_shop_activations
  where shop_id = p_shop_id;

  insert into public.central_shop_activations (
    shop_id, activation_code_hash, expires_at
  ) values (
    p_shop_id, p_activation_hash, p_expires_at
  )
  returning central_shop_activations.id into new_activation_id;

  return query select new_activation_id;
end;
$$;

revoke all on function public.central_consume_shop_activation(text, text)
  from public, anon, authenticated;
revoke all on function public.central_reissue_shop_activation(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.central_consume_shop_activation(text, text) to service_role;
grant execute on function public.central_reissue_shop_activation(uuid, text, timestamptz) to service_role;
revoke all on function public.central_create_shop(
  text, text, text, text, text, text, timestamptz, integer, integer, text[], text[], text, timestamptz
) from public, anon, authenticated;
grant execute on function public.central_create_shop(
  text, text, text, text, text, text, timestamptz, integer, integer, text[], text[], text, timestamptz
) to service_role;
