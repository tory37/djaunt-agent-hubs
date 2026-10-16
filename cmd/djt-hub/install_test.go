package main

import (
	"encoding/xml"
	"os/exec"
	"strings"
	"testing"
)

func TestRenderLaunchAgentEscapesValues(t *testing.T) {
	plist, err := renderLaunchAgent(launchAgent{
		Label:   launchAgentLabel,
		Binary:  "/Users/me/a&b/djt-hub",
		Address: "127.0.0.1:7717",
		DataDir: "/Users/me/<data>",
		Path:    "/opt/homebrew/bin:/usr/bin",
		LogFile: "/Users/me/<data>/daemon.log",
	})
	if err != nil {
		t.Fatal(err)
	}
	decoder := xml.NewDecoder(strings.NewReader(plist))
	decoder.Strict = false
	var textNodes []string
	for {
		token, err := decoder.Token()
		if err != nil {
			break
		}
		if text, isText := token.(xml.CharData); isText {
			textNodes = append(textNodes, string(text))
		}
	}
	joined := strings.Join(textNodes, "|")
	for _, want := range []string{"/Users/me/a&b/djt-hub", "|serve|", "/Users/me/<data>", "/opt/homebrew/bin:/usr/bin"} {
		if !strings.Contains(joined, want) {
			t.Errorf("plist text missing %q", want)
		}
	}
}

func TestCLIDocsPrintsAgentGuide(t *testing.T) {
	output, err := exec.Command(cliBinary, "docs").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"# djt-hub", "gate.approve", "svc add"} {
		if !strings.Contains(string(output), want) {
			t.Errorf("docs missing %q", want)
		}
	}
}
