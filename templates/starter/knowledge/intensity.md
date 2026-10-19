# Intensity Modes

## Passive
- Minimal interference with the agent's normal operation
- Only essential hooks and skills are active
- Default safety margins and conservative behavior
- Best for: production environments, conservative agents, safety-critical contexts

## Moderate
- Standard feature set balanced between capability and safety
- All core skills and hooks are active with default configurations
- Balanced performance/safety trade-off
- Best for: general-purpose agents, regular development workflows

## Aggressive
- All features enabled at maximum capacity
- All skills and hooks active with aggressive configurations
- Minimal safety margins, maximum monitoring
- Best for: experimental environments, research agents, maximum capability scenarios

### Choosing an Intensity Mode

The intensity mode is configured via the `intensity` field in the OKF knowledge bundle's frontmatter, or through the `anyplugin intensity --mode <level>` CLI command. The default is `full` (moderate).

### Switching Modes at Runtime

Agents respect the `ANYPLUGIN_INTENSITY` environment variable or the `intensity` setting in the plugin's configuration. Switching modes may require re-loading the plugin bundle.