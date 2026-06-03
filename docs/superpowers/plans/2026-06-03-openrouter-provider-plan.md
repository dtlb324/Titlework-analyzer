# OpenRouter Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the OpenRouter provider support as per the design specification.

**Architecture:** Custom translation layer to integrate with OpenRouter.

**Tech Stack:** OpenRouter API, Python 3.10+

---

### Task 1: Write the failing test for OpenRouter request handling

**Files:**
- Create: `tests/test_openrouter_request.py`
- Modify: None
- Test: `tests/test_openrouter_request.py`

- [ ] **Step 1: Write the test case for OpenRouter request handling**

```python
import unittest
from your_module import send_openrouter_request

class TestOpenRouterRequest(unittest.TestCase):
    def test_request_handling(self):
        # Mock the API
        # ... your test logic ...
        self.assertEqual(response.status_code, 200)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_openrouter_request.py::TestOpenRouterRequest::test_request_handling -v`
Expected: FAIL

- [ ] **Step 3: Implement the minimal code to make the test pass**

```python
# In your implementation file
import requests

def send_openrouter_request(data):
    url = "https://openrouter.ai/api/v1/chat/completions"
    response = requests.post(url, json=data)
    return response.json()["choices"][0]["text"]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pytest tests/test_openrouter_request.py::TestOpenRouterRequest::test_request_handling -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
 git add tests/test_openrouter_request.py your_module.py
 git commit -m "feat: add minimal OpenRouter request handling"
```
