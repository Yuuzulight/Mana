@echo off
REM CI-runner wrapper for Windows: runs retriever, node, smoke test, and unit tests in sequence
REM Usage: ci_run.bat

powershell -ExecutionPolicy Bypass -File "%~dp0ci_run.ps1" %*
