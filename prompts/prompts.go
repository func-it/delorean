// Package prompts holds every word the implementations put to a model: one
// JSON file per stage. The Go quoter embeds them; TypeScript and Python
// read the same files at startup.
package prompts

import "embed"

// Files are guard.json, parse.json, identify.json and judge.json.
//
//go:embed *.json
var Files embed.FS
