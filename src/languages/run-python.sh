#!/bin/bash

# Run a python source file with the name "$2" (with previous generated bytecode cache)
#
# $1: The `python` program used to run the source file
# $2: The absolute path of python source file directory
# $@: The remaining parameters to pass to the python program
#

SOURCE_FILENAME="$2"

PYTHON="$1"

shift 2
parameters=("$@")

if [[ "$PYTHON" == "python3.9" ]]; then
    source /opt/judge3.9/bin/activate
elif [[ "$PYTHON" == "python3.10" ]]; then
    source /opt/judge3.10/bin/activate
fi

$PYTHON "$SOURCE_FILENAME" "${parameters[@]}"

if [[ "$PYTHON" == "python3.9" ]]; then
    deactivate
elif [[ "$PYTHON" == "python3.10" ]]; then
    deactivate
fi
