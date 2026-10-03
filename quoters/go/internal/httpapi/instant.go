package httpapi

import (
	"encoding/json"
	"time"
)

// Instant is a time as every quoter writes it: UTC with milliseconds,
// 2026-10-03T13:10:22.946Z. The contract's date-time maps to it
// (oapi-codegen.yaml).
type Instant time.Time

const instantLayout = "2006-01-02T15:04:05.000Z07:00"

func (t Instant) MarshalJSON() ([]byte, error) {
	return json.Marshal(time.Time(t).UTC().Format(instantLayout))
}

func (t *Instant) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	v, err := time.Parse(time.RFC3339Nano, s)
	*t = Instant(v)
	return err
}
