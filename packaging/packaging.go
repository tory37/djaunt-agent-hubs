// Package packaging embeds the launchd agent template.
package packaging

import _ "embed"

//go:embed com.djaunt.djt-hub.plist.tmpl
var LaunchAgentTemplate string
