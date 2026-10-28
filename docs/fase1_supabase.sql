-- Fase 1 seguridad: registro de pedidos de PayPal ya usados (anti-reutilización)
create table if not exists public.paypal_order_uses (
  id bigserial primary key,
  paypal_order_id text not null,
  transaction_id  text not null unique,
  kind            text not null check (kind in ('esim','topup')),
  offer_id        text,
  amount_paid     numeric(10,2),
  created_at      timestamptz not null default now()
);
create index if not exists paypal_order_uses_order_idx on public.paypal_order_uses (paypal_order_id);
alter table public.paypal_order_uses enable row level security; -- solo la service key del servidor accede

-- Evita registrar dos veces el mismo pedido en referidos
create unique index if not exists referral_uses_order_uidx on public.referral_uses (order_id);
