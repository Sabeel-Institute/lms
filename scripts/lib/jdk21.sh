# shellcheck shell=bash
# Sourced, not run. The Firebase emulators need JDK 21+, while the
# Android/Gradle build keeps 17 as the default `java`, so only what sources
# this gets 21.
#
# Resolution order: SR_JDK21_HOME, then a user-local ~/opt/jdk-21, then
# whatever java is already on PATH (CI provides 21 through setup-java).
if [ -n "${SR_JDK21_HOME:-}" ]; then
  export JAVA_HOME="$SR_JDK21_HOME"
elif [ -d "$HOME/opt/jdk-21" ]; then
  export JAVA_HOME="$HOME/opt/jdk-21"
fi
if [ -n "${JAVA_HOME:-}" ]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi
