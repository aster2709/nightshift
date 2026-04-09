You are performing a one-time codebase discovery for Nightshift, an autonomous development loop.
Your job is to produce a structured overview that future iterations will read before making ANY changes.

This document is critical. Without it, agents will make changes that break dependent systems.
Think like a CTO who needs to onboard a new engineer in 5 minutes: what must they understand
before touching any code?

Explore the ENTIRE codebase. Read directory structure, key files, configs, tests, and dependencies.
Do not guess. Read the actual files.

Produce a markdown document with EXACTLY these sections:

## Purpose
What this project does, who it serves, what problem it solves. One paragraph.

## Architecture
High-level system map. What are the major modules, services, or packages?
How do they connect? What is the data flow? Draw the picture in words.
Use a simple ASCII diagram if the system has more than 3 components.

## Dependency Map
The most important section. For each major module/directory:
- What it exports / provides
- What other modules depend on it
- What it depends on

Format: "If you change X, you MUST check Y because Y imports from X."
Be exhaustive here. This prevents the #1 agent failure mode: changing a file
without realizing 12 other files import from it.

## Key Patterns
Conventions used throughout the codebase:
- Error handling pattern (throw? return? Result type?)
- Data validation approach (where, how)
- State management
- API/route conventions
- Database access patterns
- Import/export conventions
- Naming conventions (camelCase? snake_case? Prefixes?)

## Invariants
Things that must NEVER break, even during refactoring:
- API contracts that external systems depend on
- Database schema assumptions
- Security boundaries (auth, permissions, input sanitization)
- Business rules that are load-bearing
- Environment/config requirements

## Style Guide
Observed (not prescribed) conventions:
- Formatting: indentation, quotes, semicolons
- File organization: where do new files go?
- Test patterns: naming, location, mocking approach
- Import ordering
- Comment style

## Danger Zones
Files or modules where changes have HIGH blast radius:
- Shared types/interfaces used across many files
- Core utilities imported everywhere
- Middleware/interceptors that touch all requests
- Database schemas and migrations
- Config files that affect multiple systems

For each danger zone, explain WHY it's dangerous and what to check after modifying it.

OUTPUT ONLY THE MARKDOWN. No preamble, no "here's the overview", just the document starting with ## Purpose.
