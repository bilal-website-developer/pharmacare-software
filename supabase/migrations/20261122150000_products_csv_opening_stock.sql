CREATE OR REPLACE FUNCTION public.products_bulk_import_with_opening_stock(rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result jsonb;
  v_row jsonb;
  v_shop_id uuid := tenant_private.current_shop_id();
  v_medicine_id uuid;
  v_batch_id uuid;
  v_code text;
  v_quantity integer;
  v_cost_paisa integer;
  v_price_paisa integer;
  v_factor integer;
  v_base_quantity bigint;
  v_expiry date;
  v_batch_number text;
BEGIN
  v_result := public.products_bulk_import(rows);

  FOR v_row IN SELECT value FROM jsonb_array_elements(rows)
  LOOP
    v_quantity := coalesce(nullif(btrim(v_row->>'opening_stock_qty'), '')::integer, 0);
    v_batch_number := nullif(btrim(v_row->>'opening_batch_number'), '');

    IF v_quantity < 0 OR v_quantity > 2147483647 THEN
      RAISE EXCEPTION 'Opening stock quantity must be a non-negative whole number';
    END IF;

    IF v_quantity = 0 THEN
      IF v_batch_number IS NOT NULL
        OR nullif(btrim(v_row->>'opening_expiry_date'), '') IS NOT NULL
        OR nullif(btrim(v_row->>'opening_cost_paisa'), '') IS NOT NULL THEN
        RAISE EXCEPTION 'Opening batch details require a positive opening stock quantity';
      END IF;
      CONTINUE;
    END IF;

    IF NOT public.can_view_cost() THEN
      RAISE EXCEPTION 'Cost-price permission is required to import opening stock';
    END IF;

    IF v_batch_number IS NULL
      OR coalesce(v_row->>'opening_expiry_date', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'Opening stock requires a batch number and YYYY-MM-DD expiry date';
    END IF;
    v_expiry := (v_row->>'opening_expiry_date')::date;
    IF v_expiry <= current_date THEN
      RAISE EXCEPTION 'Opening batch expiry must be in the future';
    END IF;

    v_cost_paisa := nullif(btrim(v_row->>'opening_cost_paisa'), '')::integer;
    v_price_paisa := nullif(btrim(v_row->>'price_paisa'), '')::integer;
    IF v_cost_paisa IS NULL OR v_cost_paisa < 0
      OR v_price_paisa IS NULL OR v_price_paisa < 0 THEN
      RAISE EXCEPTION 'Opening batch cost and sale price must be non-negative whole paisa values';
    END IF;

    v_code := btrim(v_row->>'code');
    SELECT medicine.id INTO v_medicine_id
    FROM public.medicines AS medicine
    WHERE medicine.shop_id = v_shop_id
      AND medicine.code = v_code
    LIMIT 1;
    IF v_medicine_id IS NULL THEN
      RAISE EXCEPTION 'Imported product % could not be found in the current shop', v_code;
    END IF;

    SELECT unit.conversion_factor INTO v_factor
    FROM public.medicine_units AS unit
    WHERE unit.medicine_id = v_medicine_id
      AND unit.is_default_sale_unit
      AND unit.is_active
    LIMIT 1;
    IF v_factor IS NULL OR v_factor < 1 THEN
      RAISE EXCEPTION 'Imported product % has no valid default sale unit', v_code;
    END IF;

    v_base_quantity := v_quantity::bigint * v_factor;
    IF v_base_quantity > 2147483647 THEN
      RAISE EXCEPTION 'Opening stock quantity exceeds the supported stock limit for %', v_code;
    END IF;

    INSERT INTO public.stock_batches (
      shop_id, medicine_id, batch_number, expiry_date, received_date,
      cost_paisa_per_base_unit, mrp_paisa_per_base_unit,
      quantity_received, quantity_remaining, status
    )
    VALUES (
      v_shop_id, v_medicine_id, v_batch_number, v_expiry, current_date,
      round(v_cost_paisa::numeric / v_factor)::integer,
      round(v_price_paisa::numeric / v_factor)::integer,
      v_base_quantity::integer, v_base_quantity::integer, 'ACTIVE'
    )
    RETURNING id INTO v_batch_id;

    INSERT INTO public.stock_movements (
      shop_id, batch_id, movement_type, quantity_delta, reason, created_by
    )
    VALUES (
      v_shop_id, v_batch_id, 'RECEIPT', v_base_quantity::integer,
      'Opening stock imported from product CSV', auth.uid()
    );
  END LOOP;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.products_bulk_import_with_opening_stock(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.products_bulk_import_with_opening_stock(jsonb) TO authenticated;
