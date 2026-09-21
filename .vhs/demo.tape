# Demo recording for the README. Regenerate with:  vhs .vhs/demo.tape
# Requires https://github.com/charmbracelet/vhs and a built, linked CLI (`npm run build && npm link`).
# NOTE: not rendered yet; render it, review the GIF, and commit assets/demo.gif.

Output assets/demo.gif
Require node

Set Shell "bash"
Set FontSize 15
Set Width 1100
Set Height 640
Set Padding 20
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"

Hide
Type "export PORT=4000 && d=$(mktemp -d) && cd $d && clear" Enter
Show

Type "regrade init" Enter
Sleep 2s

Hide
Type "node regrade/mock-pipeline.mjs > /dev/null 2>&1 &" Enter
Type "sleep 1 && clear" Enter
Show

Type "regrade run regrade/suite.json --repeat 3" Enter
Sleep 8s

Hide
Type "kill %1" Enter
