"""
Template step executor using Stagehand hybrid approach:
- agent() for complex multi-step flows
- act()/observe()/extract() for individual steps and checkpoints
"""
import asyncio
from typing import Any


async def execute_template(stagehand, template: dict, project: dict) -> list[dict]:
    """Execute all steps of a test template."""
    steps = template.get("steps", [])
    if isinstance(steps, str):
        import json
        steps = json.loads(steps)
    
    # Sort steps by order
    steps = sorted(steps, key=lambda s: s.get("order", 0))
    
    results = []
    
    for step in steps:
        step_result = await execute_step(stagehand, step, project)
        results.append(step_result)
        
        # If a step fails and it's critical, we may want to stop
        if not step_result.get("passed", False) and step.get("type") in ("navigate", "assertion"):
            # Continue anyway but record the failure
            pass
    
    return results


async def execute_step(stagehand, step: dict, project: dict) -> dict:
    """Execute a single test step."""
    step_type = step.get("type", "action")
    instruction = step.get("instruction", "")
    
    try:
        if step_type == "navigate":
            url = step.get("url", "")
            if not url.startswith("http"):
                url = f'{project["app_url"].rstrip("/")}/{url.lstrip("/")}'
            await stagehand.page.goto(url)
            await asyncio.sleep(2)
            return {"type": step_type, "instruction": instruction, "passed": True}
        
        elif step_type == "action":
            # For complex multi-step actions, use agent
            if len(instruction.split()) > 15:
                agent = stagehand.agent(
                    model="google/gemini-2.5-computer-use-preview-10-2025",
                    system_prompt="You are a QA tester executing test steps on a web application.",
                )
                await agent.execute(instruction, max_steps=10)
            else:
                await stagehand.act(instruction)
            
            await asyncio.sleep(1)
            return {"type": step_type, "instruction": instruction, "passed": True}
        
        elif step_type == "assertion":
            expected = step.get("expected", instruction)
            observations = await stagehand.observe(expected)
            passed = observations is not None and len(observations) > 0
            
            return {
                "type": step_type,
                "instruction": instruction,
                "expected": expected,
                "passed": passed,
                "observations": str(observations) if observations else None,
                "error": f"Assertion failed: could not observe '{expected}'" if not passed else None,
            }
        
        elif step_type == "extract":
            data = await stagehand.extract(instruction)
            return {
                "type": step_type,
                "instruction": instruction,
                "passed": True,
                "extracted_data": str(data) if data else None,
            }
        
        elif step_type == "wait":
            timeout = step.get("timeout", 3000)
            await asyncio.sleep(timeout / 1000)
            return {"type": step_type, "instruction": instruction, "passed": True}
        
        else:
            return {"type": step_type, "instruction": instruction, "passed": False, "error": f"Unknown step type: {step_type}"}
    
    except Exception as e:
        return {
            "type": step_type,
            "instruction": instruction,
            "passed": False,
            "error": str(e),
        }
