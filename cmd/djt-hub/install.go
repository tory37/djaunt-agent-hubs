package main

import (
	"context"
	"encoding/xml"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"text/template"
	"time"

	"github.com/tory37/djaunt-agent-hubs/docs"
	"github.com/tory37/djaunt-agent-hubs/packaging"
)

const (
	launchAgentLabel  = "com.djaunt.djt-hub"
	bootstrapAttempts = 10
	startupTimeout    = 10 * time.Second
	pollInterval      = 200 * time.Millisecond
)

var errNotMacOS = errors.New("install uses launchd and only runs on macOS; run `djt-hub serve` under your own supervisor")

type launchAgent struct {
	Label, Binary, Address, DataDir, Path, LogFile string
}

func runDocs(ctx context.Context, args []string) error {
	fmt.Print(docs.AgentGuide)
	return nil
}

func renderLaunchAgent(agent launchAgent) (string, error) {
	escape := func(value string) (string, error) {
		var escaped strings.Builder
		err := xml.EscapeText(&escaped, []byte(value))
		return escaped.String(), err
	}
	parsed, err := template.New("plist").Funcs(template.FuncMap{"xml": escape}).Parse(packaging.LaunchAgentTemplate)
	if err != nil {
		return "", err
	}
	var rendered strings.Builder
	err = parsed.Execute(&rendered, agent)
	return rendered.String(), err
}

func launchAgentPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist")
}

func launchdDomain() string { return fmt.Sprintf("gui/%d", os.Getuid()) }

// runInstall writes the launchd agent for this binary and (re)loads it, so a
// rebuilt binary takes over on every install.
func runInstall(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("install", flag.ContinueOnError)
	address := flags.String("addr", daemonAddress(), "listen address (loopback only)")
	dataDirectory := flags.String("data", dataDir(), "data directory")
	if _, err := parseArgs(flags, args); err != nil {
		return err
	}
	if runtime.GOOS != "darwin" {
		return errNotMacOS
	}
	if err := requireLoopback(*address); err != nil {
		return err
	}
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	if binary, err = filepath.EvalSymlinks(binary); err != nil {
		return err
	}
	if err := os.MkdirAll(*dataDirectory, 0o755); err != nil {
		return err
	}
	plist, err := renderLaunchAgent(launchAgent{
		Label:   launchAgentLabel,
		Binary:  binary,
		Address: *address,
		DataDir: *dataDirectory,
		Path:    os.Getenv("PATH"),
		LogFile: filepath.Join(*dataDirectory, "daemon.log"),
	})
	if err != nil {
		return err
	}
	plistPath := launchAgentPath()
	if err := os.MkdirAll(filepath.Dir(plistPath), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(plistPath, []byte(plist), 0o644); err != nil {
		return err
	}

	exec.CommandContext(ctx, "launchctl", "bootout", launchdDomain()+"/"+launchAgentLabel).Run()
	if err := bootstrap(ctx, plistPath); err != nil {
		return err
	}
	if err := waitForDaemon(ctx, *address); err != nil {
		return fmt.Errorf("%w; see %s", err, filepath.Join(*dataDirectory, "daemon.log"))
	}
	fmt.Printf("djt-hub installed: %s\nrunning at http://%s\n", plistPath, *address)
	return nil
}

// bootstrap retries because launchd refuses a bootstrap while the previous
// instance of the same label is still unloading.
func bootstrap(ctx context.Context, plistPath string) error {
	var output []byte
	var err error
	for attempt := 0; attempt < bootstrapAttempts; attempt++ {
		output, err = exec.CommandContext(ctx, "launchctl", "bootstrap", launchdDomain(), plistPath).CombinedOutput()
		if err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollInterval):
		}
	}
	return fmt.Errorf("launchctl bootstrap: %v: %s", err, strings.TrimSpace(string(output)))
}

func waitForDaemon(ctx context.Context, address string) error {
	healthURL := "http://" + address + "/api/health"
	httpClient := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(startupTimeout)
	for time.Now().Before(deadline) {
		response, err := httpClient.Get(healthURL)
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollInterval):
		}
	}
	return fmt.Errorf("daemon did not answer at %s within %s", address, startupTimeout)
}

func runUninstall(ctx context.Context, args []string) error {
	if runtime.GOOS != "darwin" {
		return errNotMacOS
	}
	exec.CommandContext(ctx, "launchctl", "bootout", launchdDomain()+"/"+launchAgentLabel).Run()
	plistPath := launchAgentPath()
	if err := os.Remove(plistPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	fmt.Println("djt-hub uninstalled; hub data left in place")
	return nil
}
