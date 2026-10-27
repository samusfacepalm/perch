# Dev: run a second Perch window with its own profile and the debugging port open.
$env:PERCH_DEV_PROFILE = "1"
npx electron . --remote-debugging-port=9333
