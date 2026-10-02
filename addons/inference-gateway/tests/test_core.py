"""Run from addons/inference-gateway: python -m unittest discover tests"""
import asyncio
import unittest

from orchestrator.core import InferenceRequest, ManaOrchestrator


def bare_orchestrator():
    # Skip __init__: it probes hardware; these tests only cover backend lookup.
    orch = ManaOrchestrator.__new__(ManaOrchestrator)
    orch._backends = {}
    orch.config = {}
    return orch


class BackendLookupTest(unittest.TestCase):
    def test_ensure_backends_registers_on_empty_dict(self):
        orch = bare_orchestrator()
        asyncio.run(orch.ensure_backends())
        self.assertEqual(sorted(orch._backends), ["llama_cpp", "vllm"])

    def test_unregistered_backend_is_a_clear_error(self):
        orch = bare_orchestrator()
        asyncio.run(orch.ensure_backends())
        with self.assertRaisesRegex(RuntimeError, "'colibri' is not registered"):
            asyncio.run(orch._backend_call("colibri", InferenceRequest(), {}))


if __name__ == "__main__":
    unittest.main()
