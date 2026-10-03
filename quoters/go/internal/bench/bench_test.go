package bench

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// repoCases is the repository's cases/, from this package.
const repoCases = "../../../../cases"

// Every case of the repository is well formed: what `bench check` runs in CI.
func TestRepositoryCasesAreWellFormed(t *testing.T) {
	problems, err := Validate(repoCases)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range problems {
		t.Error(p)
	}
	for _, name := range Names() {
		cases, err := Load(filepath.Join(repoCases, Folder(name)))
		if err != nil || len(cases) == 0 {
			t.Errorf("%s: %d cases, %v", name, len(cases), err)
		}
	}
}

// casesIn writes files under a fresh cases folder: path → content.
func casesIn(t *testing.T, files map[string]string) string {
	t.Helper()
	base := t.TempDir()
	for _, f := range Folders() {
		if err := os.MkdirAll(filepath.Join(base, f), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for p, content := range files {
		path := filepath.Join(base, p)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return base
}

// Validate says what is wrong with each case, all of it, and nothing about a
// well-formed one.
func TestValidateSaysWhatIsWrong(t *testing.T) {
	good := map[string]string{
		"quote/ok.json":    `{"id":"ok","note":"n","tags":["fake"],"input":{"cart":"BTTF 1"},"expect":{"status":200,"total_cents":1500,"films":{"bttf_1":1}}}`,
		"guard/ok.json":    `{"id":"ok","note":"n","input":{"text":"BTTF 1"},"expect":{"verdict":"valid"}}`,
		"identify/ok.json": `{"id":"ok","note":"n","input":{"title":"BTTF 1"},"expect":{"film":"bttf_1"}}`,
		"reading/ok.json":  `{"id":"ok","note":"n","input":{"text":"Bonjour"},"expect":{"films":{}}}`,
		"judge/ok.json":    `{"id":"ok","note":"n","input":{"text":"BTTF 1","lines":[{"title":"BTTF 1","quantity":1,"film":"bttf_1"}]},"expect":{"faithful":true}}`,
	}
	problems, err := Validate(casesIn(t, good))
	if err != nil || len(problems) > 0 {
		t.Fatalf("well-formed cases: %v, %v", problems, err)
	}

	for _, tc := range []struct {
		file, content, want string
	}{
		{"guard/a.json", `{"id":"b","note":"n","input":{"text":"x"},"expect":{"verdict":"valid"}}`, `id "b"`},
		{"guard/a.json", `{"id":"a","note":" ","input":{"text":"x"},"expect":{"verdict":"valid"}}`, "no note"},
		{"guard/a.json", `{"id":"a","note":"n","input":{"text":"x"},"expect":{"verdict":"maybe"}}`, `verdict "maybe" unknown`},
		{"guard/a.json", `{"id":"a","note":"n","input":{"cart":"x"},"expect":{"verdict":"valid"}}`, `unknown field "cart"`},
		{"guard/a.json", `{"id":"a","note":"n","tags":["x","x"],"input":{"text":"x"},"expect":{"verdict":"valid"}}`, "repeated"},
		{"identify/a.json", `{"id":"a","note":"n","input":{"title":"x"},"expect":{"film":"bttf_4"}}`, `film "bttf_4" unknown`},
		{"reading/a.json", `{"id":"a","note":"n","input":{"text":"x"},"expect":{"films":{"bttf_1":0}}}`, "quantity 0"},
		{"reading/a.json", `{"id":"a","note":"n","input":{"text":"x"},"expect":{}}`, "expect.films missing"},
		{"judge/a.json", `{"id":"a","note":"n","input":{"text":"x","lines":[]},"expect":{"faithful":false}}`, "input.lines empty"},
		{"judge/a.json", `{"id":"a","note":"n","input":{"text":"x","lines":[{"title":"x","quantity":1,"film":"other"}]},"expect":{"faithful":true,"check":"asked"}}`, "expects no failing check"},
		{"judge/a.json", `{"id":"a","note":"n","input":{"text":"x","lines":[{"title":"x","quantity":1,"film":"other"}]},"expect":{"check":"asked"}}`, "faithful missing"},
		{"quote/a.json", `{"id":"a","note":"n","input":{"cart":"x"},"expect":{"status":400,"code":"injection"}}`, "comes with status 422"},
		{"quote/a.json", `{"id":"a","note":"n","input":{"cart":"x"},"expect":{"status":422,"code":"too_short"}}`, `code "too_short" unknown`},
		{"quote/a.json", `{"id":"a","note":"n","input":{"cart":"x"},"expect":{"status":200}}`, "expects total_cents"},
		{"films/a.json", `{"id":"a","note":"n","input":{},"expect":{}}`, "no subject reads this folder"},
	} {
		problems, err := Validate(casesIn(t, map[string]string{tc.file: tc.content}))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(strings.Join(problems, "\n"), tc.want) {
			t.Errorf("%s %s: problems %q, want %q", tc.file, tc.content, problems, tc.want)
		}
	}

	base := casesIn(t, good)
	if err := os.RemoveAll(filepath.Join(base, "judge")); err != nil {
		t.Fatal(err)
	}
	if problems, _ := Validate(base); len(problems) != 1 || !strings.Contains(problems[0], "judge: missing") {
		t.Errorf("a missing folder: %q", problems)
	}
}

// Load refuses a case whose id is not its file name: the id is what Langfuse
// keys the dataset item on.
func TestLoadRefusesAMisnamedCase(t *testing.T) {
	base := casesIn(t, map[string]string{"guard/a.json": `{"id":"b","note":"n","input":{"text":"x"},"expect":{"verdict":"valid"}}`})
	if _, err := Load(filepath.Join(base, "guard")); err == nil || !strings.Contains(err.Error(), "b.json") {
		t.Errorf("err %v", err)
	}
}
