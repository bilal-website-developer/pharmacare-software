create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  shop_code text unique not null,
  shop_name text not null,
  owner_email text,
  owner_phone text,
  status text not null default 'PENDING_ACTIVATION',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  license_key text unique not null,
  license_type text not null default 'TRIAL',
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  grace_days integer not null default 30,
  max_devices integer not null default 1,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'REVOKED')),
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

alter table public.licenses
  add column if not exists status text not null default 'ACTIVE';

alter table public.licenses
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

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'licenses_enabled_pages_valid'
  ) then
    alter table public.licenses add constraint licenses_enabled_pages_valid check (
      enabled_pages <@ array[
        'pos', 'products', 'categories', 'suppliers', 'customers', 'sales_history',
        'purchase_history', 'purchases', 'expenses', 'stock_inventory', 'reports',
        'manage_users', 'settings'
      ]::text[]
    );
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'licenses_enabled_features_valid'
  ) then
    alter table public.licenses add constraint licenses_enabled_features_valid check (
      enabled_features <@ array[
        'pos_print_sale', 'pos_print_payment', 'settings_shop_profile',
        'settings_receipt_memo', 'settings_receipt_qr', 'settings_operations',
        'settings_demo_data', 'settings_whatsapp_templates'
      ]::text[]
    );
  end if;
end;
$$;

create table if not exists public.developer_owners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.shop_activations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  activation_code_hash text unique not null,
  admin_username text,
  is_used boolean not null default false,
  used_at timestamptz,
  expires_at timestamptz not null,
  installation_fingerprint text
);

create table if not exists public.shop_checkins (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  app_version text,
  os_version text,
  checkin_ip text,
  checkin_time timestamptz not null default now()
);

create table if not exists public.software_versions (
  id uuid primary key default gen_random_uuid(),
  version text unique not null,
  release_date timestamptz not null default now(),
  min_supported_version text,
  release_notes text,
  installer_url text,
  installer_sha256 text,
  is_mandatory boolean not null default false
);

create table if not exists public.admin_password_resets (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  reset_token_hash text not null,
  is_used boolean not null default false,
  expires_at timestamptz not null
);

alter table public.shops enable row level security;
alter table public.licenses enable row level security;
alter table public.shop_activations enable row level security;
alter table public.shop_checkins enable row level security;
alter table public.developer_owners enable row level security;

revoke all on public.developer_owners from anon, authenticated;
grant all on public.developer_owners to service_role;

create or replace function public.consume_shop_activation(
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
  update public.shop_activations activation
  set is_used = true,
      used_at = now(),
      installation_fingerprint = p_hardware_fingerprint
  where activation.activation_code_hash = p_activation_hash
    and activation.is_used = false
    and activation.expires_at > now()
    and exists (
      select 1
      from public.shops shop
      join public.licenses license on license.shop_id = shop.id
      where shop.id = activation.shop_id
        and shop.status in ('PENDING_ACTIVATION', 'ACTIVE')
        and license.status = 'ACTIVE'
        and (license.expires_at is null or license.expires_at > now())
    )
  returning activation.shop_id into claimed_shop_id;

  if claimed_shop_id is null then
    return;
  end if;

  update public.shops
  set status = 'ACTIVE', updated_at = now()
  where id = claimed_shop_id;

  return query select claimed_shop_id;
end;
$$;

revoke all on function public.consume_shop_activation(text, text) from public, anon, authenticated;
grant execute on function public.consume_shop_activation(text, text) to service_role;
