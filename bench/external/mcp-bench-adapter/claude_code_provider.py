"""Sentinel LLM provider for the Claude Code adapter.

MCP-Bench's runner instantiates an LLM provider per task and hands it
to TaskExecutor. For our adapter, Claude Code IS the agent — it manages
its own LLM calls internally — so there's no LLM for MCP-Bench to call.

This class exists purely to (a) be detectable by isinstance() in the
runner branch that swaps TaskExecutor for ClaudeCodeExecutor, and (b)
fail loudly if any code path mistakenly tries to call get_completion()
on it (which would silently break the variant).
"""

from typing import Any, Optional, Tuple, Union


class ClaudeCodeProvider:
    """Sentinel — never produces completions. Runner must detect this
    type and route around it."""

    def __init__(self, model: str = "claude-sonnet-4-6") -> None:
        self.model = model
        self.deployment_name = f"claude-code/{model}"
        self.provider_type = "claude_code"

    async def get_completion(
        self,
        system_prompt: str,
        user_prompt: str,
        max_tokens: Optional[int] = None,
        return_usage: bool = False,
    ) -> Union[str, Tuple[str, Any]]:
        raise RuntimeError(
            "ClaudeCodeProvider.get_completion called — runner failed to "
            "detect the claude_code provider_type and swap in ClaudeCodeExecutor"
        )
