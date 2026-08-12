// Command plugin-rill is the managed backend for the kandev-plugin-opscost plugin.
//
// It does nothing, deliberately, and that is the whole design.
//
// This plugin is UI-only: its entire job is to mount a Rill dashboard as a tab
// in Kandev's navigation. Kandev's installer nonetheless requires
// `runtime.type: binary`, so a host executable must exist. Embedding
// pluginsdk.UnimplementedPlugin satisfies the Plugin interface with no-op
// OnEvent/HandleWebhook and gives Kandev a process to supervise.
//
// It deliberately does NOT start Rill. The plugin authoring guide is explicit:
// "Do not launch a second long-running server from the plugin." Kandev
// supervises this binary's lifecycle and would fight anything else it spawned,
// so the UI probes for an already-running Rill and tells the operator how to
// start one instead.
package main

import "github.com/kandev/kandev/pkg/pluginsdk"

type opsCostPlugin struct {
	pluginsdk.UnimplementedPlugin
}

func main() {
	pluginsdk.Serve(&opsCostPlugin{})
}
