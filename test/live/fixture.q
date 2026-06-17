\ Test fixture loaded by npm run test:live-kdb. It intentionally uses simple,
\ local in-memory data so the live test exercises a real q process without
\ needing production data or credentials.

\ Community kdb+/q builds can reject IPC logins unless an auth hook is present.
\ This local-only fixture accepts IPC handshakes for integration testing.
.z.pw:{[u;p] 1b}

trade:([]
  sym:`AAPL`MSFT`GOOG;
  size:100 250 75i;
  price:123.45 234.56 345.67;
  day:2024.01.01 2024.01.02 2024.01.03;
  ts:2024.01.01D09:30:00.000000000 2024.01.01D09:31:00.000000000 2024.01.01D09:32:00.000000000)

quote:([sym:`AAPL`MSFT]
  bid:123.40 234.50;
  ask:123.50 234.60)

calcSpread:{[bid;ask] ask-bid}
