import os
from pathlib import Path

from cursor_sdk import Agent, CloudAgentOptions, CloudRepository


def load_env_file(path=".env"):
    env_path = Path(path)
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file()


with Agent.create(
    model="composer-2.5",
    api_key=os.environ["CURSOR_API_KEY"],
    cloud=CloudAgentOptions(
        repos=[
            CloudRepository(
                url="https://github.com/dtlb324/Titlework-analyzer",
                starting_ref="main",
            )
        ],
        auto_create_pr=True,
        skip_reviewer_request=True,
    ),
) as agent:
    run = agent.send(
        "Review the release workflow and tell me what could go wrong. "
        "Do not make file changes."
    )

    print(run.text())
    print("Agent ID:", agent.agent_id)
