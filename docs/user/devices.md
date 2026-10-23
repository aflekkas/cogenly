# Devices

The Device panel shows a live iOS Simulator or Android Emulator next to a
thread, so you can watch an agent verify mobile work and tap the device
yourself. Agents get the same device through `device_*` tools and the
`agent-device` command line, which Cogenly sets up for them.

## Open a device

In a Work thread, choose **Device** from the right panel's **+** menu and pick a
simulator or emulator, grouped by host. It opens as its own tab; a device that is
already open is checked and selecting it switches to its tab. Chats have no devices.

Devices are on by default. Cogenly installs and starts the device hub the first
time a device is needed, whether you open one or an agent asks for one, so there is
nothing to set up first. **Device setup** (at the bottom of the **+ → Device** menu
and in the panel) shows what is installed, whether iOS and Android work on each
host, and offers a retry when an install fails.

A stopped device boots when you open it, and the tab shows it starting. The panel
also shows when an agent starts a device.
Double-click a tab name or choose **Rename** from its context menu to rename it.
Only the visible tab streams video; switching tabs keeps both devices running.
Turn off the device hub in **Settings → Integrations → Devices** to stop the
helper processes and keep it off; simulators and emulators keep running until you
power them off.

Simulators run on the machine that hosts the environment server. iOS needs
macOS with Xcode. Android needs the SDK Platform-Tools, Android Emulator,
and Command-line Tools (latest), plus a virtual device created in Android
Studio's Device Manager. Cogenly detects standard SDK locations; set
`ANDROID_HOME` for a custom location. The panel explains missing dependencies.
After installing them, restart the environment server and refresh devices.

The screen is interactive: click and drag to touch, type while the screen is
focused, and use the toolbar for Home, Back, and Recents on Android, rotate on
iOS, and power off. Close the tab to stop watching; the device keeps running
unless you power it off. Closed tabs stay closed after a reload. To watch the
device again, choose it from **+ → Device**.

Choose **3D view** to inspect supported devices while the live screen stays
interactive. On iPhone Duo, use the fold and stance controls to change its
physical pose, or pinch over the device to adjust the hinge. Turning the model
to the other screen switches the live display and touch input to that screen.
**Restore 3D view** returns the device to a screen-facing position.
On supported Android foldables, use **Fold device** and **Unfold device** beside
the screen to change its posture in either view.

## Tools

The toolbar's **Tools** button opens a drawer for the open device. It shows the
foreground app, and lets you switch light and dark mode, change text size,
flip accessibility settings, overlay the accessibility element frames on the
screen, set a fake location, and grant or revoke app permissions. iOS also
exposes Liquid Glass, color filters, VoiceOver, and sending a test push
notification; Android adds orientation and toggling the network. The drawer
only shows what the platform can do, and every control reflects the value read
back from the device after a change.

## Agents and devices

When an agent opens a device, it opens in a right-panel tab in web and desktop
clients connected to the thread, the same way an agent-driven browser does.
If the thread has several devices open, choose one in the viewer. Closing the
viewer stops streaming and leaves the device available to the agent. Device
activity also appears in the thread timeline.

Agents drive the device through the `agent-device` command line. Cogenly
installs and starts it when an agent first opens a device, as long as **Agent
device access** is on (the default). iOS
taps build a small test runner on first use, which takes a couple of minutes
once per server. Restart an existing agent session after turning access back on
so it receives the device CLI environment.

To keep agents away from simulators, turn off **Agent device access** in
**Settings → Integrations → Devices**. This hides the device tools from agents
started from then on; your own Device panel is unaffected.

## Remote connections

The device stream goes through the environment server, so it works over the
local network, Tailscale, and Cogenly Connect. Live video needs a secure page
(HTTPS or localhost); on a plain-HTTP remote origin iOS falls back to a slower
still-image stream and Android cannot show video.

## SSH device hosts

In Settings → Integrations → Devices, choose the environments that should use
the host and add it under **Device hosts**. Enter an SSH alias or `user@host`, with
an optional identity file and port. These resolve on the environment server,
so use the SSH configuration and keys available there. Password prompts are
not supported.

**Test connection** checks SSH, Node, npm, and platform tools without installing
anything, with a result for each selected environment. Targets that resolve to
the environment’s own machine are skipped, since its devices are already local.
The first device listing installs pinned device tools on the host.
Node 22 or newer and npm must be available to non-interactive SSH commands.
Cogenly checks common Homebrew and Android SDK locations; custom installations need
the appropriate PATH and ANDROID_HOME on the host.

The picker identifies devices by host when several hosts are configured.
Connections recover after interruptions. Removing a host closes its device
sessions and stops its Cogenly helpers when reachable; simulators keep running.

Cogenly provides discovery, streaming, and control. Arrange app builds,
installation, and connectivity to development servers such as Metro separately.
A simulator on another machine cannot reach Metro through your environment's
localhost without forwarding or another reachable address.

## Device tool updates

The connected Cogenly server manages the device hub and agent tools on its own machine and configured SSH hosts. Required versions install automatically the next time those tools are used. Settings → Integrations → Check device tool versions reads installed versions without installing tools or starting devices.

To receive newer tool versions on a remote environment, update that environment's Cogenly server. Updating only the browser does not update the remote server. An offline host keeps its installed files, but an update needs network access before device support can start; Cogenly does not fall back to an older version. Reconnect the host and use Retry if installation fails. Existing device and agent-access settings are preserved.
