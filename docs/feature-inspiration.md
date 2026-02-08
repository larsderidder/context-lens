# Feature Inspiration - Code Patterns for Context Lens

**Generated:** 2026-02-08  
**Based on:** Scout's analysis of webpack-bundle-analyzer, Lighthouse, Langfuse, Grafana

---

## 1. Treemap Visualization (from webpack-bundle-analyzer)

### Source Files
- `client/components/Treemap.jsx` - FoamTree wrapper  
- `client/components/ModulesTreemap.jsx` - Main treemap UI with controls  
- `client/store.js` - MobX store for data model

### Key Code Pattern: Hierarchical Color Coding

**Original (ModulesTreemap.jsx lines 70-80):**
```javascript
// HSL-based hash for consistent colors per module
function getModuleColor(moduleName) {
  const hash = hashString(moduleName);
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 50%)`;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}
```

**Context Lens Adaptation:**
```javascript
// Map context component types to consistent colors
const COMPONENT_TYPE_COLORS = {
  'system': 'hsl(200, 70%, 50%)',    // Blue
  'tool': 'hsl(280, 70%, 50%)',       // Purple
  'message': 'hsl(140, 70%, 50%)',    // Green
  'document': 'hsl(30, 70%, 50%)',    // Orange
  'embedding': 'hsl(330, 70%, 50%)',  // Pink
};

function getComponentColor(component) {
  // Use type-based color as base
  const baseColor = COMPONENT_TYPE_COLORS[component.type] || 'hsl(0, 0%, 50%)';
  
  // For same-type components, vary lightness based on hash
  if (component.name) {
    const hash = hashString(component.name);
    const lightness = 40 + (hash % 20); // 40-60% lightness range
    return baseColor.replace(/50%/, `${lightness}%`);
  }
  
  return baseColor;
}
```

### Data Model Pattern

**Original (store.js):**
```javascript
{
  allChunks: [],
  selectedChunks: [],
  selectedSize: "statSize",  // Metric selector
  activeSize: computed,       // Derived metric
  visibleChunks: computed     // Filtered data
}
```

**Context Lens Adaptation:**
```javascript
// Zustand store for treemap state
const useTreemapStore = create((set, get) => ({
  components: [],
  selectedMetric: 'tokens',  // tokens | cost | latency
  searchQuery: '',
  zoomedComponent: null,
  
  // Computed values
  get visibleComponents() {
    const { components, searchQuery } = get();
    if (!searchQuery) return components;
    
    // Filter matching components
    return components.filter(c => 
      c.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  },
  
  get metricValue() {
    const { selectedMetric } = get();
    return (component) => {
      switch (selectedMetric) {
        case 'tokens': return component.tokenSize.total;
        case 'cost': return component.cost.toNumber();
        case 'latency': return component.duration;
        default: return component.tokenSize.total;
      }
    };
  },
  
  setMetric: (metric) => set({ selectedMetric: metric }),
  setSearch: (query) => set({ searchQuery: query }),
  zoomTo: (componentId) => set({ zoomedComponent: componentId }),
}));
```

### Treemap Data Structure

**Context Lens Format:**
```javascript
{
  groups: [
    {
      label: "System Prompt",
      type: "system",
      tokens: 450,
      cost: 0.00045,
      children: []
    },
    {
      label: "Tools",
      type: "tool",
      tokens: 3200,
      cost: 0.0032,
      children: [
        {
          label: "web_search",
          type: "tool",
          tokens: 1200,
          cost: 0.0012,
          children: []
        },
        {
          label: "browser",
          type: "tool",
          tokens: 2000,
          cost: 0.002,
          children: []
        }
      ]
    },
    {
      label: "Messages",
      type: "message",
      tokens: 5800,
      cost: 0.0058,
      children: [
        // Individual messages
      ]
    }
  ]
}
```

### Implementation Plan

**Phase 1: Basic Treemap (12-16 hours)**
1. Install D3: `npm install d3-hierarchy d3-scale d3-selection`
2. Create `TreemapViz.jsx` component using D3's treemap layout
3. Implement hierarchical data transformation (context components → D3 format)
4. Add hover tooltips showing token count, cost, type

**Phase 2: Interactive Features (4-6 hours)**
5. Implement metric switcher (tokens/cost/latency)
6. Add search/filter with highlight
7. Implement zoom/drill-down on click
8. Add color coding by component type

**Libraries:**
- `d3-hierarchy` - Treemap layout algorithm
- `d3-scale` - Color scaling
- `zustand` - State management (already in stack)

**Component Structure:**
```
components/visualizations/
├── Treemap/
│   ├── TreemapViz.jsx          # Main D3 treemap component
│   ├── TreemapControls.jsx     # Metric selector, search
│   ├── TreemapTooltip.jsx      # Hover details
│   └── useTreemapStore.js      # Zustand store
└── shared/
    └── colorUtils.js           # Color generation utilities
```

---

## 2. Scoring/Recommendations System (from Lighthouse)

### Source Files
- `core/scoring.js` - Score calculation algorithms  
- `report/renderer/explodey-gauge.js` - Circular gauge component  
- `report/renderer/category-renderer.js` - Category grouping UI

### Key Code Pattern: Weighted Scoring

**Original (scoring.js):**
```javascript
/**
 * Calculate weighted arithmetic mean of audit scores
 * @param {Array<{score: number|null, weight: number}>} items
 * @return {number|null}
 */
function arithmeticMean(items) {
  // Filter to weighted items only
  items = items.filter(item => item.weight > 0);
  
  // If any item has null score, entire category is null
  if (items.some(item => item.score === null)) {
    return null;
  }
  
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  const weightedSum = items.reduce((sum, item) => 
    sum + (item.score * item.weight), 0
  );
  
  return clampTo2Decimals(weightedSum / totalWeight);
}

function clampTo2Decimals(val) {
  return Math.round(val * 100) / 100;
}
```

**Context Lens Adaptation:**
```javascript
// Context health metrics
const CONTEXT_HEALTH_AUDITS = [
  {
    id: 'context-utilization',
    weight: 25,
    name: 'Context Window Utilization',
    description: 'How efficiently the context window is being used',
    calculate: (trace) => {
      const usage = trace.metrics.totalTokens / trace.contextLimit;
      // Optimal: 60-80% utilization
      if (usage < 0.4) return 0.5; // Underutilized
      if (usage > 0.9) return 0.3; // Dangerously full
      if (usage >= 0.6 && usage <= 0.8) return 1.0; // Optimal
      return 0.7; // Acceptable
    }
  },
  {
    id: 'tool-efficiency',
    weight: 20,
    name: 'Tool Definition Efficiency',
    description: 'Ratio of used tools vs defined tools',
    calculate: (trace) => {
      const toolsUsed = trace.components.filter(c => 
        c.type === 'tool' && c.metadata.actuallyUsed
      ).length;
      const toolsDefined = trace.components.filter(c => 
        c.type === 'tool'
      ).length;
      
      if (toolsDefined === 0) return 1.0;
      const efficiency = toolsUsed / toolsDefined;
      
      // Penalize if < 30% usage
      if (efficiency < 0.3) return efficiency * 0.5;
      return efficiency;
    }
  },
  {
    id: 'message-freshness',
    weight: 15,
    name: 'Message History Freshness',
    description: 'How recent and relevant the message history is',
    calculate: (trace) => {
      const messages = trace.components.filter(c => c.type === 'message');
      if (messages.length === 0) return 1.0;
      
      const now = new Date();
      const avgAge = messages.reduce((sum, msg) => {
        const ageMinutes = (now - msg.timestamp) / 1000 / 60;
        return sum + ageMinutes;
      }, 0) / messages.length;
      
      // Fresher is better
      if (avgAge < 5) return 1.0;
      if (avgAge < 30) return 0.8;
      if (avgAge < 120) return 0.6;
      return 0.4;
    }
  },
  {
    id: 'redundancy-detection',
    weight: 20,
    name: 'Content Redundancy',
    description: 'Detects duplicate or highly similar content',
    calculate: (trace) => {
      // Simplified: check for exact duplicate messages
      const messages = trace.components.filter(c => c.type === 'message');
      const contentSet = new Set(messages.map(m => m.content));
      
      const uniqueness = contentSet.size / messages.length;
      return uniqueness; // 1.0 = no duplicates, <1.0 = redundancy
    }
  },
  {
    id: 'cost-efficiency',
    weight: 20,
    name: 'Cost per Quality Token',
    description: 'Balance of cost vs valuable context',
    calculate: (trace) => {
      const costPerToken = trace.metrics.totalCost / trace.metrics.totalTokens;
      
      // Model-specific benchmarks (example for GPT-4)
      const benchmarkCost = 0.00003; // $0.03 per 1K tokens
      const ratio = benchmarkCost / costPerToken;
      
      return Math.min(ratio, 1.0); // Cap at 1.0
    }
  }
];

function calculateContextHealth(trace) {
  const auditResults = CONTEXT_HEALTH_AUDITS.map(audit => ({
    ...audit,
    score: audit.calculate(trace),
  }));
  
  // Calculate weighted average
  const totalWeight = auditResults.reduce((sum, a) => sum + a.weight, 0);
  const weightedSum = auditResults.reduce((sum, a) => 
    sum + (a.score * a.weight), 0
  );
  
  const overallScore = Math.round((weightedSum / totalWeight) * 100) / 100;
  
  return {
    overall: overallScore,
    audits: auditResults,
    rating: getHealthRating(overallScore)
  };
}

function getHealthRating(score) {
  if (score >= 0.9) return { label: 'Excellent', color: 'green' };
  if (score >= 0.7) return { label: 'Good', color: 'lightgreen' };
  if (score >= 0.5) return { label: 'Fair', color: 'orange' };
  return { label: 'Poor', color: 'red' };
}
```

### Circular Gauge Component

**Original (explodey-gauge.js):**
```javascript
// SVG circular gauge (0-100 scale)
class ExplodeyGauge {
  render(score) {
    const percentage = score * 100;
    const angle = (percentage / 100) * 270; // 270° arc
    
    // Color coding
    let color;
    if (percentage >= 90) color = '#0cce6b'; // Green
    else if (percentage >= 50) color = '#ffa400'; // Orange
    else color = '#ff4e42'; // Red
    
    return `
      <svg viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="56" fill="none" stroke="#e0e0e0" stroke-width="8"/>
        <circle cx="60" cy="60" r="56" fill="none" stroke="${color}" stroke-width="8"
                stroke-dasharray="${angle * 0.98} 270"
                transform="rotate(-135 60 60)"/>
        <text x="60" y="60" text-anchor="middle" font-size="32">${Math.round(percentage)}</text>
      </svg>
    `;
  }
}
```

**Context Lens Adaptation (React):**
```jsx
// components/visualizations/HealthGauge.jsx
export function HealthGauge({ score, size = 120 }) {
  const percentage = Math.round(score * 100);
  const angle = (percentage / 100) * 270; // 270° arc
  const radius = size / 2 - 8;
  const circumference = 2 * Math.PI * radius;
  const arcLength = (270 / 360) * circumference;
  const strokeDashoffset = arcLength - (percentage / 100) * arcLength;
  
  // Color based on score
  const color = 
    percentage >= 90 ? '#10b981' :  // Green
    percentage >= 70 ? '#f59e0b' :  // Amber
    percentage >= 50 ? '#f97316' :  // Orange
    '#ef4444';                       // Red
  
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {/* Background arc */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="#e5e7eb"
        strokeWidth="8"
        strokeDasharray={`${arcLength} ${circumference}`}
        transform={`rotate(-135 ${size / 2} ${size / 2})`}
      />
      
      {/* Filled arc */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="8"
        strokeDasharray={`${arcLength} ${circumference}`}
        strokeDashoffset={strokeDashoffset}
        transform={`rotate(-135 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.5s ease' }}
      />
      
      {/* Score text */}
      <text
        x={size / 2}
        y={size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={size / 3.5}
        fontWeight="600"
        fill="#111827"
      >
        {percentage}
      </text>
      
      {/* Label */}
      <text
        x={size / 2}
        y={size / 2 + size / 6}
        textAnchor="middle"
        fontSize={size / 12}
        fill="#6b7280"
      >
        Health Score
      </text>
    </svg>
  );
}
```

### Implementation Plan

**Phase 1: Scoring System (2-3 hours)**
1. Create `scoring.js` utility with weighted average function
2. Define 5 initial health audits (utilization, tool efficiency, freshness, redundancy, cost)
3. Implement audit calculation functions
4. Add health rating labels (Excellent/Good/Fair/Poor)

**Phase 2: Gauge Visualization (3-4 hours)**
5. Build `HealthGauge.jsx` React component
6. Add color coding and animations
7. Create `HealthPanel.jsx` showing overall score + individual audit scores
8. Add expandable audit details with explanations

**Files:**
```
lib/
└── scoring.js                  # Weighted average, audit definitions

components/visualizations/
├── HealthGauge.jsx             # Circular gauge component
├── HealthPanel.jsx             # Overall health dashboard
└── AuditDetails.jsx            # Individual audit breakdown
```

---

## 3. Context Diff Between Turns (from Langfuse)

### Source Files
- `components/trace2/lib/tree-building.ts` - Tree comparison logic  
- `components/trace2/components/TraceTimeline/timeline-flattening.ts` - Flattening algorithm

### Key Code Pattern: Tree Comparison

**Concept (adapted from Langfuse's approach):**
```typescript
// Compare two trace trees and identify changes
interface ContextDiff {
  added: ContextComponent[];
  removed: ContextComponent[];
  modified: ContextComponent[];
  unchanged: ContextComponent[];
}

function diffContextTrees(
  previousTrace: ContextWindowTrace,
  currentTrace: ContextWindowTrace
): ContextDiff {
  const prevMap = new Map(
    previousTrace.components.map(c => [c.id, c])
  );
  const currMap = new Map(
    currentTrace.components.map(c => [c.id, c])
  );
  
  const diff: ContextDiff = {
    added: [],
    removed: [],
    modified: [],
    unchanged: []
  };
  
  // Find added and modified components
  for (const [id, curr] of currMap) {
    const prev = prevMap.get(id);
    
    if (!prev) {
      diff.added.push(curr);
    } else if (hasChanged(prev, curr)) {
      diff.modified.push({
        ...curr,
        previousValue: prev
      });
    } else {
      diff.unchanged.push(curr);
    }
  }
  
  // Find removed components
  for (const [id, prev] of prevMap) {
    if (!currMap.has(id)) {
      diff.removed.push(prev);
    }
  }
  
  return diff;
}

function hasChanged(prev: ContextComponent, curr: ContextComponent): boolean {
  // Check token count changes
  if (prev.tokenSize.total !== curr.tokenSize.total) return true;
  
  // Check content changes (for messages)
  if (prev.type === 'message' && curr.type === 'message') {
    return prev.content !== curr.content;
  }
  
  // Check metadata changes
  return JSON.stringify(prev.metadata) !== JSON.stringify(curr.metadata);
}
```

### Diff Visualization Component

**Context Lens Implementation:**
```jsx
// components/visualizations/ContextDiff.jsx
export function ContextDiff({ previousTrace, currentTrace }) {
  const diff = diffContextTrees(previousTrace, currentTrace);
  
  return (
    <div className="context-diff">
      <DiffStats diff={diff} />
      
      <div className="diff-sections">
        {diff.added.length > 0 && (
          <DiffSection
            title="Added Components"
            items={diff.added}
            type="added"
            color="green"
          />
        )}
        
        {diff.removed.length > 0 && (
          <DiffSection
            title="Removed Components"
            items={diff.removed}
            type="removed"
            color="red"
          />
        )}
        
        {diff.modified.length > 0 && (
          <DiffSection
            title="Modified Components"
            items={diff.modified}
            type="modified"
            color="amber"
          />
        )}
      </div>
    </div>
  );
}

function DiffStats({ diff }) {
  const totalChanges = diff.added.length + diff.removed.length + diff.modified.length;
  
  const tokenDelta = 
    diff.added.reduce((sum, c) => sum + c.tokenSize.total, 0) -
    diff.removed.reduce((sum, c) => sum + c.tokenSize.total, 0) +
    diff.modified.reduce((sum, c) => 
      sum + (c.tokenSize.total - c.previousValue.tokenSize.total), 0
    );
  
  return (
    <div className="diff-stats">
      <Stat label="Total Changes" value={totalChanges} />
      <Stat 
        label="Token Delta" 
        value={tokenDelta > 0 ? `+${tokenDelta}` : tokenDelta}
        color={tokenDelta > 0 ? 'green' : 'red'}
      />
      <Stat label="Added" value={diff.added.length} color="green" />
      <Stat label="Removed" value={diff.removed.length} color="red" />
      <Stat label="Modified" value={diff.modified.length} color="amber" />
    </div>
  );
}

function DiffSection({ title, items, type, color }) {
  return (
    <details open>
      <summary className={`diff-section-header bg-${color}-50`}>
        <span className="font-semibold">{title}</span>
        <span className="text-sm text-gray-600">({items.length})</span>
      </summary>
      
      <ul className="diff-items">
        {items.map((item, i) => (
          <li key={i} className={`diff-item diff-${type}`}>
            <ComponentIcon type={item.type} />
            <span className="component-name">{item.name}</span>
            <span className="token-count">{item.tokenSize.total} tokens</span>
            
            {type === 'modified' && (
              <span className="token-delta">
                ({item.tokenSize.total - item.previousValue.tokenSize.total > 0 ? '+' : ''}
                {item.tokenSize.total - item.previousValue.tokenSize.total})
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
```

### Turn-by-Turn Navigation

```jsx
// components/TraceNavigator.jsx
export function TraceNavigator({ traces, currentIndex, onIndexChange }) {
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex < traces.length - 1;
  
  const currentTrace = traces[currentIndex];
  const previousTrace = hasPrevious ? traces[currentIndex - 1] : null;
  
  return (
    <div className="trace-navigator">
      <div className="nav-controls">
        <button 
          onClick={() => onIndexChange(currentIndex - 1)}
          disabled={!hasPrevious}
        >
          ← Previous Turn
        </button>
        
        <span className="turn-counter">
          Turn {currentIndex + 1} of {traces.length}
        </span>
        
        <button 
          onClick={() => onIndexChange(currentIndex + 1)}
          disabled={!hasNext}
        >
          Next Turn →
        </button>
      </div>
      
      {previousTrace && (
        <ContextDiff 
          previousTrace={previousTrace}
          currentTrace={currentTrace}
        />
      )}
    </div>
  );
}
```

### Implementation Plan

**Phase 1: Diff Algorithm (3-4 hours)**
1. Create `diffContextTrees()` function in `lib/diff.js`
2. Implement component comparison logic
3. Add token delta calculations
4. Handle nested component changes

**Phase 2: Diff UI (4-5 hours)**
5. Build `ContextDiff.jsx` component
6. Create visual indicators for added/removed/modified
7. Add expandable sections for each change type
8. Implement turn-by-turn navigation

**Phase 3: Timeline Integration (3-4 hours)**
9. Add diff overlay to timeline view
10. Highlight changed components in timeline
11. Animate transitions between turns

**Files:**
```
lib/
└── diff.js                     # Diff algorithm

components/
├── TraceNavigator.jsx          # Turn-by-turn controls
└── visualizations/
    ├── ContextDiff.jsx         # Diff visualization
    └── DiffStats.jsx           # Summary statistics
```

---

## 4. Cost Tracking Over Time (from Langfuse)

### Source Files
- `components/trace2/lib/tree-building.ts` - Cost aggregation  
- `web/src/features/public-api/types/traces.ts` - Cost data types

### Key Code Pattern: Bottom-Up Cost Aggregation

**Original (tree-building.ts):**
```typescript
// Aggregate costs from children to parent
function aggregateCosts(node: TraceNode): Decimal {
  if (node.children.length === 0) {
    return node.totalCost;
  }
  
  const childrenCost = node.children.reduce(
    (sum, child) => sum.plus(aggregateCosts(child)),
    new Decimal(0)
  );
  
  return node.totalCost.plus(childrenCost);
}

// Build tree with aggregated costs
function buildTraceTree(flatNodes: TraceNode[]): TraceNode {
  const nodeMap = new Map(flatNodes.map(n => [n.id, n]));
  
  // Find root
  const root = flatNodes.find(n => !n.parentId);
  
  // Recursively aggregate
  function aggregate(nodeId: string): Decimal {
    const node = nodeMap.get(nodeId);
    const children = flatNodes.filter(n => n.parentId === nodeId);
    
    node.children = children;
    node.aggregatedCost = children.reduce(
      (sum, child) => sum.plus(aggregate(child.id)),
      node.totalCost
    );
    
    return node.aggregatedCost;
  }
  
  aggregate(root.id);
  return root;
}
```

**Context Lens Adaptation:**
```typescript
// lib/cost-tracking.ts
import Decimal from 'decimal.js';

// Model pricing (per 1M tokens)
const MODEL_PRICING = {
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'claude-3-5-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku': { input: 0.80, output: 4.00 },
};

interface CostBreakdown {
  inputTokens: number;
  outputTokens: number;
  inputCost: Decimal;
  outputCost: Decimal;
  totalCost: Decimal;
}

function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): CostBreakdown {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    throw new Error(`Unknown model: ${model}`);
  }
  
  // Convert per-1M pricing to per-token
  const inputCost = new Decimal(inputTokens)
    .mul(pricing.input)
    .div(1_000_000);
  
  const outputCost = new Decimal(outputTokens)
    .mul(pricing.output)
    .div(1_000_000);
  
  return {
    inputTokens,
    outputTokens,
    inputCost,
    outputCost,
    totalCost: inputCost.plus(outputCost)
  };
}

// Aggregate costs across trace tree
function aggregateTraceCosts(trace: ContextWindowTrace): CostBreakdown {
  function aggregateNode(component: ContextComponent): CostBreakdown {
    // Start with node's own cost
    let cost = component.cost;
    let inputTokens = component.tokenSize.input;
    let outputTokens = component.tokenSize.output;
    
    // Add children costs
    for (const child of component.children) {
      const childCost = aggregateNode(child);
      cost = cost.plus(childCost.totalCost);
      inputTokens += childCost.inputTokens;
      outputTokens += childCost.outputTokens;
    }
    
    return {
      inputTokens,
      outputTokens,
      inputCost: cost.mul(inputTokens / (inputTokens + outputTokens)),
      outputCost: cost.mul(outputTokens / (inputTokens + outputTokens)),
      totalCost: cost
    };
  }
  
  // Aggregate from root components
  return trace.components
    .filter(c => !c.parentId)
    .reduce((total, root) => {
      const rootCost = aggregateNode(root);
      return {
        inputTokens: total.inputTokens + rootCost.inputTokens,
        outputTokens: total.outputTokens + rootCost.outputTokens,
        inputCost: total.inputCost.plus(rootCost.inputCost),
        outputCost: total.outputCost.plus(rootCost.outputCost),
        totalCost: total.totalCost.plus(rootCost.totalCost)
      };
    }, {
      inputTokens: 0,
      outputTokens: 0,
      inputCost: new Decimal(0),
      outputCost: new Decimal(0),
      totalCost: new Decimal(0)
    });
}

// Session-level cost tracking
interface SessionCosts {
  sessionId: string;
  model: string;
  traces: Array<{
    traceId: string;
    timestamp: Date;
    cost: CostBreakdown;
  }>;
  totalCost: Decimal;
  averageCostPerRequest: Decimal;
}

function trackSessionCosts(traces: ContextWindowTrace[]): SessionCosts {
  const traceCosts = traces.map(trace => ({
    traceId: trace.id,
    timestamp: trace.timestamp,
    cost: aggregateTraceCosts(trace)
  }));
  
  const totalCost = traceCosts.reduce(
    (sum, t) => sum.plus(t.cost.totalCost),
    new Decimal(0)
  );
  
  return {
    sessionId: traces[0]?.sessionId,
    model: traces[0]?.model,
    traces: traceCosts,
    totalCost,
    averageCostPerRequest: totalCost.div(traces.length)
  };
}
```

### Cost Visualization Component

```jsx
// components/visualizations/CostTracker.jsx
import { Line } from 'recharts';
import { LineChart, XAxis, YAxis, Tooltip, Legend } from 'recharts';

export function CostTracker({ sessionCosts }) {
  // Transform data for chart
  const chartData = sessionCosts.traces.map((trace, i) => ({
    turn: i + 1,
    cost: trace.cost.totalCost.toNumber(),
    inputCost: trace.cost.inputCost.toNumber(),
    outputCost: trace.cost.outputCost.toNumber(),
    cumulativeCost: sessionCosts.traces
      .slice(0, i + 1)
      .reduce((sum, t) => sum + t.cost.totalCost.toNumber(), 0)
  }));
  
  return (
    <div className="cost-tracker">
      <CostSummary costs={sessionCosts} />
      
      <div className="cost-chart">
        <h3>Cost Over Time</h3>
        <LineChart width={800} height={300} data={chartData}>
          <XAxis dataKey="turn" label={{ value: 'Turn', position: 'bottom' }} />
          <YAxis label={{ value: 'Cost ($)', angle: -90, position: 'left' }} />
          <Tooltip formatter={(value) => `$${value.toFixed(4)}`} />
          <Legend />
          
          <Line 
            type="monotone" 
            dataKey="cost" 
            stroke="#3b82f6" 
            name="Cost per Turn"
            strokeWidth={2}
          />
          <Line 
            type="monotone" 
            dataKey="cumulativeCost" 
            stroke="#10b981" 
            name="Cumulative Cost"
            strokeWidth={2}
          />
        </LineChart>
      </div>
      
      <CostBreakdownTable costs={sessionCosts} />
    </div>
  );
}

function CostSummary({ costs }) {
  return (
    <div className="grid grid-cols-4 gap-4">
      <StatCard
        label="Total Cost"
        value={`$${costs.totalCost.toFixed(4)}`}
        color="blue"
      />
      <StatCard
        label="Avg per Request"
        value={`$${costs.averageCostPerRequest.toFixed(4)}`}
        color="green"
      />
      <StatCard
        label="Total Requests"
        value={costs.traces.length}
        color="purple"
      />
      <StatCard
        label="Model"
        value={costs.model}
        color="gray"
      />
    </div>
  );
}

function CostBreakdownTable({ costs }) {
  return (
    <table className="cost-table">
      <thead>
        <tr>
          <th>Turn</th>
          <th>Timestamp</th>
          <th>Input Tokens</th>
          <th>Output Tokens</th>
          <th>Input Cost</th>
          <th>Output Cost</th>
          <th>Total Cost</th>
        </tr>
      </thead>
      <tbody>
        {costs.traces.map((trace, i) => (
          <tr key={trace.traceId}>
            <td>{i + 1}</td>
            <td>{trace.timestamp.toLocaleTimeString()}</td>
            <td>{trace.cost.inputTokens.toLocaleString()}</td>
            <td>{trace.cost.outputTokens.toLocaleString()}</td>
            <td>${trace.cost.inputCost.toFixed(5)}</td>
            <td>${trace.cost.outputCost.toFixed(5)}</td>
            <td className="font-semibold">
              ${trace.cost.totalCost.toFixed(5)}
            </td>
          </tr>
        ))}
        <tr className="font-bold border-t-2">
          <td colSpan={2}>Total</td>
          <td>{costs.traces.reduce((s, t) => s + t.cost.inputTokens, 0).toLocaleString()}</td>
          <td>{costs.traces.reduce((s, t) => s + t.cost.outputTokens, 0).toLocaleString()}</td>
          <td>${costs.traces.reduce((s, t) => s + t.cost.inputCost.toNumber(), 0).toFixed(5)}</td>
          <td>${costs.traces.reduce((s, t) => s + t.cost.outputCost.toNumber(), 0).toFixed(5)}</td>
          <td>${costs.totalCost.toFixed(5)}</td>
        </tr>
      </tbody>
    </table>
  );
}
```

### Implementation Plan

**Phase 1: Cost Calculation (2-3 hours)**
1. Install decimal.js: `npm install decimal.js`
2. Create `cost-tracking.ts` with model pricing
3. Implement `calculateCost()` function
4. Add `aggregateTraceCosts()` for tree aggregation

**Phase 2: Session Tracking (2-3 hours)**
5. Implement `trackSessionCosts()` for multi-trace sessions
6. Add cost persistence to trace storage
7. Create cost accumulation utilities

**Phase 3: Visualization (4-5 hours)**
8. Install recharts: `npm install recharts`
9. Build `CostTracker.jsx` with line chart
10. Add cost breakdown table
11. Implement export to CSV

**Files:**
```
lib/
└── cost-tracking.ts            # Cost calculation & aggregation

components/visualizations/
├── CostTracker.jsx             # Main cost visualization
├── CostSummary.jsx             # Summary cards
└── CostBreakdownTable.jsx      # Detailed table
```

---

## Summary: Implementation Priorities

### Phase 1: Foundation (Week 1)
1. **Scoring system** (2-3 hours) - Quick win, valuable insights
2. **Health gauge** (3-4 hours) - Visual impact
3. **Cost tracking** (4-6 hours) - Core feature

**Total:** 9-13 hours

### Phase 2: Core Visualizations (Week 2)
4. **Timeline from Langfuse** (already planned separately)
5. **Context diff** (7-9 hours) - Turn comparison
6. **Treemap** (12-16 hours) - Component breakdown

**Total:** 19-25 hours

### Phase 3: Polish (Week 3)
7. Integration and testing
8. Export features (PDF, CSV)
9. Performance optimization

### Dependencies to Install

```bash
npm install \
  d3-hierarchy d3-scale d3-selection \
  decimal.js \
  recharts \
  zustand
```

### Total Effort Estimate
- **Tier 1 (Foundation):** 9-13 hours
- **Tier 2 (Core Viz):** 19-25 hours
- **Tier 3 (Polish):** 8-12 hours

**Grand Total:** 36-50 hours for all features

---

## Next Steps

1. Review this document with Lars
2. Prioritize features based on Context Lens roadmap
3. Start with scoring system (quick win)
4. Prototype health gauge (visual demo)
5. Build timeline calculations (foundation for diff + treemap)

Each feature is modular and can be implemented independently. Start with highest ROI items (scoring, gauge, cost tracking) before tackling complex visualizations (treemap, timeline).
