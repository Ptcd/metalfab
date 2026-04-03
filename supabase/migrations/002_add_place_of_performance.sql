-- Add place_of_performance column to opportunities table
-- This stores the extracted location string for proximity-based scoring
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS place_of_performance text;

-- Backfill from raw_data for SGS records
UPDATE opportunities
SET place_of_performance =
  CASE
    WHEN raw_data->'placeOfPerformance' IS NOT NULL
      AND jsonb_typeof(raw_data->'placeOfPerformance') = 'array'
      AND jsonb_array_length(raw_data->'placeOfPerformance') > 0
    THEN concat_ws(', ',
      nullif(raw_data->'placeOfPerformance'->0->>'city', ''),
      nullif(raw_data->'placeOfPerformance'->0->>'state', ''),
      nullif(raw_data->'placeOfPerformance'->0->>'country', '')
    )
    WHEN raw_data->'placeOfPerformance' IS NOT NULL
      AND jsonb_typeof(raw_data->'placeOfPerformance') = 'object'
    THEN concat_ws(', ',
      nullif(raw_data->'placeOfPerformance'->>'city', ''),
      nullif(raw_data->'placeOfPerformance'->>'state', ''),
      nullif(raw_data->'placeOfPerformance'->>'country', '')
    )
    ELSE NULL
  END
WHERE place_of_performance IS NULL;
