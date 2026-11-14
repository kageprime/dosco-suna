"""The one HCL block reader of the Terraform guard tests in this directory."""

import re


def block(config, header):
    """Return the text of the block starting at `header` up to its closing brace.

    `header` ends with the block's opening `{`.
    """
    start = config.index(header)
    return config[start : _closing_brace(config, start + len(header), header) + 1]


def resource_body(source: str, resource_type: str, name: str) -> str:
    match = re.search(
        rf'resource\s+"{re.escape(resource_type)}"\s+"{re.escape(name)}"\s*{{',
        source,
    )
    assert match, f"missing {resource_type}.{name}"
    return source[match.end() : _closing_brace(source, match.end(), f"{resource_type}.{name}")]


def _closing_brace(source: str, cursor: int, label: str) -> int:
    """Index of the `}` that closes the block whose `{` ends right before `cursor`."""
    depth = 1
    while cursor < len(source) and depth:
        if source[cursor] == "{":
            depth += 1
        elif source[cursor] == "}":
            depth -= 1
        cursor += 1

    assert depth == 0, f"unterminated {label}"
    return cursor - 1
