// Package docs embeds the agent guide so the binary can print it.
package docs

import _ "embed"

//go:embed agent-guide.md
var AgentGuide string
