// The managed executable is intentionally inert. Rill is started separately;
// the plugin UI reads its task-step analysis over Rill's query API.
package main

import "github.com/kandev/kandev/pkg/pluginsdk"

type opsIntelPlugin struct{ pluginsdk.UnimplementedPlugin }

func main() {
	pluginsdk.Serve(&opsIntelPlugin{})
}
