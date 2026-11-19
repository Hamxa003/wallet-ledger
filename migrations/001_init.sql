CREATE TYPE entry_type AS ENUM ('credit', 'debit');

CREATE TABLE ledger (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     varchar(64) NOT NULL,
    type        entry_type  NOT NULL,
    amount      bigint      NOT NULL CHECK (amount > 0),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_user_id_id_idx ON ledger (user_id, id);

CREATE TABLE balances (
    user_id     varchar(64) PRIMARY KEY,
    balance     bigint      NOT NULL CHECK (balance >= 0),
    updated_at  timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 80);

CREATE FUNCTION ledger_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ledger rows are immutable';
END;
$$;

CREATE TRIGGER ledger_no_update_delete
    BEFORE UPDATE OR DELETE ON ledger
    FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();

CREATE TRIGGER ledger_no_truncate
    BEFORE TRUNCATE ON ledger
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
