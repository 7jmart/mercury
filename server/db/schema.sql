-- Mercury v1 schema bootstrap (Postgres)

create table if not exists users (
  user_id text primary key,
  phone_number text not null unique,
  display_name text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create table if not exists friend_requests (
  request_id text primary key,
  from_user_id text not null,
  to_user_id text not null,
  status text not null,
  created_at timestamptz not null,
  responded_at timestamptz
);

create table if not exists friendships (
  friendship_id text primary key,
  user_a_id text not null,
  user_b_id text not null,
  created_at timestamptz not null
);

create table if not exists rooms (
  room_id text primary key,
  host_user_id text not null,
  title text not null,
  privacy text not null,
  is_active boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  ended_at timestamptz
);

create table if not exists room_members (
  room_member_id text primary key,
  room_id text not null,
  user_id text not null,
  role text not null,
  muted boolean not null,
  unread_count integer not null,
  last_read_at timestamptz,
  joined_at timestamptz not null,
  updated_at timestamptz not null,
  left_at timestamptz
);

create table if not exists messages (
  message_id text primary key,
  room_id text not null,
  user_id text not null,
  text text not null,
  idempotency_key text,
  created_at timestamptz not null
);

create table if not exists invites (
  invite_id text primary key,
  code text not null unique,
  room_id text not null,
  created_by_user_id text not null,
  target_user_id text,
  accepted_by_user_id text,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  accepted_at timestamptz
);

create table if not exists device_push_tokens (
  device_push_token_id text primary key,
  user_id text not null,
  platform text not null,
  token text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists event_metrics (
  metric_id text primary key,
  event_name text not null,
  user_id text not null,
  room_id text,
  value numeric,
  created_at timestamptz not null
);
