#!/usr/bin/env python3
"""
Simple Python AST analyzer for detecting risky patterns.

Usage:
  python tools/python_ast_analyzer.py [path-to-file]
  (or) echo "code" | python tools/python_ast_analyzer.py

Outputs JSON array of risk objects {type: str, message: str}
"""

import ast
import json
import sys

code = None
if len(sys.argv) > 1 and sys.argv[1] != "-":
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            code = f.read()
    except Exception as e:
        print(json.dumps([{"type": "error", "message": f"failed to read file: {e}"}]))
        sys.exit(0)
else:
    try:
        code = sys.stdin.read()
    except Exception as e:
        print(json.dumps([{"type": "error", "message": f"failed to read stdin: {e}"}]))
        sys.exit(0)

if code is None:
    print(json.dumps([]))
    sys.exit(0)

risks = []


class Analyzer(ast.NodeVisitor):
    def __init__(self):
        super().__init__()

    def visit_Call(self, node):
        # detect subprocess usage via name or attribute
        func = node.func
        # func could be Name or Attribute
        if isinstance(func, ast.Name):
            if func.id in ("eval", "exec", "compile"):
                risks.append(
                    {
                        "type": "dynamic_exec",
                        "message": f"use of {func.id}() detected at line {node.lineno}",
                    }
                )
            if func.id == "open":
                # examine mode arg if literal
                if (
                    len(node.args) >= 2
                    and isinstance(node.args[1], ast.Constant)
                    and isinstance(node.args[1].value, str)
                ):
                    mode = node.args[1].value
                    if any(m in mode for m in ("w", "a", "x", "+")):
                        risks.append(
                            {
                                "type": "file_write",
                                "message": f"open(..., '{mode}') used (possible write) at line {node.lineno}",
                            }
                        )
        elif isinstance(func, ast.Attribute):
            # e.g., subprocess.run, os.system, shutil.rmtree, os.remove
            name = ast.unparse(func) if hasattr(ast, "unparse") else None
            attr = func.attr if isinstance(func, ast.Attribute) else None
            if (
                attr in ("system",)
                and isinstance(func.value, ast.Name)
                and func.value.id == "os"
            ):
                risks.append(
                    {
                        "type": "os_system",
                        "message": f"os.system used at line {node.lineno}",
                    }
                )
            if isinstance(func.value, ast.Name) and func.value.id == "subprocess":
                risks.append(
                    {
                        "type": "subprocess",
                        "message": f"subprocess usage detected ({attr}) at line {node.lineno}",
                    }
                )
            if (
                isinstance(func.value, ast.Name)
                and func.value.id == "shutil"
                and attr in ("rmtree",)
            ):
                risks.append(
                    {
                        "type": "shutil_rmtree",
                        "message": f"shutil.rmtree used at line {node.lineno}",
                    }
                )
            if (
                isinstance(func.value, ast.Name)
                and func.value.id == "os"
                and attr in ("remove", "unlink")
            ):
                risks.append(
                    {
                        "type": "os_remove",
                        "message": f"os.{attr} used at line {node.lineno}",
                    }
                )

        # check for eval-like in arguments (e.g., os.system("rm -rf /"))
        for a in node.args:
            if isinstance(a, ast.Constant) and isinstance(a.value, str):
                s = a.value
                if "rm -rf" in s or "del /F" in s or "shutdown" in s:
                    risks.append(
                        {
                            "type": "dangerous_command_literal",
                            "message": f"literal dangerous shell command in call at line {node.lineno}: {s[:80]}",
                        }
                    )
        self.generic_visit(node)

    def visit_Import(self, node):
        for n in node.names:
            if n.name == "subprocess":
                risks.append(
                    {
                        "type": "subprocess_import",
                        "message": f"import subprocess at line {node.lineno}",
                    }
                )
            if n.name == "os":
                risks.append(
                    {"type": "os_import", "message": f"import os at line {node.lineno}"}
                )
            if n.name == "shutil":
                risks.append(
                    {
                        "type": "shutil_import",
                        "message": f"import shutil at line {node.lineno}",
                    }
                )
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        mod = node.module or ""
        if mod == "subprocess" or mod.split(".")[0] == "subprocess":
            risks.append(
                {
                    "type": "subprocess_import",
                    "message": f"from {mod} import ... at line {node.lineno}",
                }
            )
        if mod == "os" or mod.split(".")[0] == "os":
            risks.append(
                {
                    "type": "os_import",
                    "message": f"from {mod} import ... at line {node.lineno}",
                }
            )
        if mod == "shutil" or mod.split(".")[0] == "shutil":
            risks.append(
                {
                    "type": "shutil_import",
                    "message": f"from {mod} import ... at line {node.lineno}",
                }
            )
        self.generic_visit(node)

    def visit_Attribute(self, node):
        # e.g., process.exit, sys.exit
        try:
            if (
                isinstance(node.value, ast.Name)
                and node.value.id == "process"
                and node.attr in ("exit", "kill")
            ):
                risks.append(
                    {
                        "type": "process_call",
                        "message": f"process.{node.attr} referenced at line {node.lineno}",
                    }
                )
        except Exception:
            pass
        self.generic_visit(node)


try:
    tree = ast.parse(code)
    a = Analyzer()
    a.visit(tree)
except Exception as e:
    risks.append({"type": "parse_error", "message": f"ast.parse failed: {e}"})

# De-duplicate messages
seen = set()
uniq = []
for r in risks:
    key = (r.get("type"), r.get("message"))
    if key in seen:
        continue
    seen.add(key)
    uniq.append(r)

print(json.dumps(uniq))
