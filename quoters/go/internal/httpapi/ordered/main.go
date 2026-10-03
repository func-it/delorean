// Command ordered runs oapi-codegen on the contract with every property
// given its rank in the contract (x-order): the structs then declare their
// fields, and encoding/json writes the keys, in the contract's order — the
// order every quoter writes (docs/architecture.md, Identical quoters).
//
//	go run ./ordered -config oapi-codegen.yaml ../../../../api/openapi.yaml
package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"

	"gopkg.in/yaml.v3"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "ordered:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: ordered [oapi-codegen flags] <contract>")
	}
	contract := args[len(args)-1]
	src, err := os.ReadFile(contract)
	if err != nil {
		return err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(src, &doc); err != nil {
		return fmt.Errorf("%s: %w", contract, err)
	}
	rank(&doc)
	out, err := yaml.Marshal(&doc)
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "ordered")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	ordered := filepath.Join(dir, filepath.Base(contract))
	if err := os.WriteFile(ordered, out, 0o600); err != nil {
		return err
	}
	cmd := exec.CommandContext(context.Background(), "go", append(append([]string{"tool", "oapi-codegen"}, args[:len(args)-1]...), ordered)...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}

// rank sets x-order on each property of every `properties` mapping below n,
// from 1 in declaration order; a $ref keeps it as a sibling.
func rank(n *yaml.Node) {
	if n.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(n.Content); i += 2 {
			if n.Content[i].Value == "properties" && n.Content[i+1].Kind == yaml.MappingNode {
				props := n.Content[i+1]
				for j := 0; j+1 < len(props.Content); j += 2 {
					setOrder(props.Content[j+1], j/2+1)
				}
			}
		}
	}
	for _, c := range n.Content {
		rank(c)
	}
}

func setOrder(prop *yaml.Node, order int) {
	if prop.Kind != yaml.MappingNode {
		return
	}
	prop.Content = append(prop.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Value: "x-order"},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(order)})
}
