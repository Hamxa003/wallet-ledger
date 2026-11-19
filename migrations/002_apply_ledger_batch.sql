CREATE FUNCTION apply_ledger_batch(p_user_id varchar, p_types entry_type[], p_amounts bigint[])
RETURNS TABLE (out_ord int, out_ok boolean, out_balance bigint, out_user_found boolean)
LANGUAGE plpgsql AS $$
DECLARE
    v_balance  bigint;
    v_exists   boolean;
    v_types    entry_type[] := '{}';
    v_amounts  bigint[] := '{}';
BEGIN
    SELECT b.balance INTO v_balance FROM balances b WHERE b.user_id = p_user_id FOR UPDATE;
    v_exists := FOUND;

    IF NOT v_exists AND 'credit' = ANY (p_types) THEN
        INSERT INTO balances (user_id, balance) VALUES (p_user_id, 0)
        ON CONFLICT (user_id) DO NOTHING;
        IF NOT FOUND THEN
            SELECT b.balance INTO v_balance FROM balances b WHERE b.user_id = p_user_id FOR UPDATE;
            v_exists := true;
        END IF;
    END IF;

    v_balance := coalesce(v_balance, 0);

    FOR i IN 1 .. coalesce(array_length(p_types, 1), 0) LOOP
        out_ord := i;
        IF p_types[i] = 'credit' THEN
            v_balance := v_balance + p_amounts[i];
            v_exists := true;
            v_types := v_types || p_types[i];
            v_amounts := v_amounts || p_amounts[i];
            out_ok := true; out_balance := v_balance; out_user_found := true;
        ELSIF NOT v_exists THEN
            out_ok := false; out_balance := NULL; out_user_found := false;
        ELSIF v_balance >= p_amounts[i] THEN
            v_balance := v_balance - p_amounts[i];
            v_types := v_types || p_types[i];
            v_amounts := v_amounts || p_amounts[i];
            out_ok := true; out_balance := v_balance; out_user_found := true;
        ELSE
            out_ok := false; out_balance := NULL; out_user_found := true;
        END IF;
        RETURN NEXT;
    END LOOP;

    IF coalesce(array_length(v_types, 1), 0) > 0 THEN
        INSERT INTO ledger (user_id, type, amount)
        SELECT p_user_id, e.type, e.amount
          FROM unnest(v_types, v_amounts) WITH ORDINALITY AS e(type, amount, ord)
         ORDER BY e.ord;

        UPDATE balances SET balance = v_balance, updated_at = now() WHERE user_id = p_user_id;
    END IF;
END;
$$;
