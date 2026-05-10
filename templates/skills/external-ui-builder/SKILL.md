# External UI Builder Skill

Generate custom UI configurations for agent external services based on natural language descriptions.

## Purpose

When creating an external-facing agent service, users can describe the desired UI experience in natural language. This skill translates those descriptions into a structured `CustomUIConfig` object that the external service renderer uses to display the chat interface.

## Output Format

The output is a JSON object conforming to the `CustomUIConfig` interface:

```typescript
interface CustomUIConfig {
  layout: 'fullpage' | 'widget' | 'sidebar';
  theme: {
    primaryColor: string;       // hex color, e.g. "#2563eb"
    backgroundColor?: string;   // page background
    textColor?: string;         // main text color
    fontFamily?: string;        // CSS font-family
    borderRadius?: string;      // e.g. "12px"
    logoUrl?: string;           // brand logo URL
    faviconUrl?: string;
  };
  components: Array<{
    type: 'chat' | 'form' | 'file-upload' | 'payment' | 'rating' | 'header' | 'footer' | 'custom';
    position: 'header' | 'footer' | 'sidebar' | 'inline' | 'overlay';
    config: Record<string, unknown>;
    showWhen?: 'always' | 'session_start' | 'session_end' | 'custom';
  }>;
  welcomeMessage?: string;
  placeholder?: string;
  customCss?: string;           // sanitized custom CSS
}
```

## Instructions

1. **Analyze the user's description** to determine:
   - Layout preference (fullpage for dedicated pages, widget for embedded, sidebar for narrow panels)
   - Brand colors and style preferences
   - Required functional components (file upload, payment, rating, forms)
   - Welcome messaging and tone
   - Any custom CSS needs

2. **Generate the configuration** following these rules:
   - Always include at minimum the `chat` component at position `inline`
   - Use accessible color contrast ratios (WCAG AA minimum)
   - Default to `fullpage` layout unless embedding is mentioned
   - Default to a clean, modern theme if no style preferences given
   - Include a `header` component if a logo or brand name is provided
   - Include a `rating` component at `session_end` if feedback/evaluation is mentioned
   - Include `file-upload` component if file sharing is mentioned
   - Include `payment` component if monetization/payment is mentioned

3. **Validate the output** ensuring:
   - All hex colors are valid
   - Font families are web-safe or include fallbacks
   - Border radius values include units
   - Component types are from the allowed set
   - Position values are from the allowed set

## Examples

### Example 1: Customer Support Bot

**Input:** "I want a professional customer support chat for our SaaS product. Blue theme, our logo at the top, file upload for screenshots, and a satisfaction rating at the end."

**Output:**
```json
{
  "layout": "fullpage",
  "theme": {
    "primaryColor": "#2563eb",
    "backgroundColor": "#f8fafc",
    "textColor": "#1e293b",
    "fontFamily": "Inter, -apple-system, sans-serif",
    "borderRadius": "12px"
  },
  "components": [
    { "type": "header", "position": "header", "config": { "title": "Support", "showLogo": true }, "showWhen": "always" },
    { "type": "chat", "position": "inline", "config": {}, "showWhen": "always" },
    { "type": "file-upload", "position": "inline", "config": { "accept": "image/*,.pdf", "maxSize": 10485760 }, "showWhen": "always" },
    { "type": "rating", "position": "overlay", "config": { "scale": 5, "label": "How was your experience?" }, "showWhen": "session_end" }
  ],
  "welcomeMessage": "Hi there! How can we help you today?",
  "placeholder": "Describe your issue..."
}
```

### Example 2: Minimal Widget

**Input:** "A small chat widget, dark theme, minimalist. No extras."

**Output:**
```json
{
  "layout": "widget",
  "theme": {
    "primaryColor": "#ffffff",
    "backgroundColor": "#1a1a2e",
    "textColor": "#e0e0e0",
    "fontFamily": "system-ui, sans-serif",
    "borderRadius": "8px"
  },
  "components": [
    { "type": "chat", "position": "inline", "config": {}, "showWhen": "always" }
  ],
  "placeholder": "Ask me anything..."
}
```

### Example 3: E-commerce Assistant with Payment

**Input:** "An e-commerce shopping assistant, warm orange branding, should be able to process payments and collect delivery info via a form."

**Output:**
```json
{
  "layout": "fullpage",
  "theme": {
    "primaryColor": "#ea580c",
    "backgroundColor": "#fffbeb",
    "textColor": "#292524",
    "fontFamily": "'Nunito', -apple-system, sans-serif",
    "borderRadius": "16px"
  },
  "components": [
    { "type": "header", "position": "header", "config": { "title": "Shopping Assistant" }, "showWhen": "always" },
    { "type": "chat", "position": "inline", "config": {}, "showWhen": "always" },
    { "type": "form", "position": "inline", "config": { "fields": ["name", "address", "phone"], "submitLabel": "Confirm Delivery" }, "showWhen": "custom" },
    { "type": "payment", "position": "overlay", "config": { "methods": ["card", "applepay"] }, "showWhen": "custom" },
    { "type": "rating", "position": "footer", "config": { "scale": 5 }, "showWhen": "session_end" }
  ],
  "welcomeMessage": "Welcome! I'm here to help you find the perfect product. What are you looking for?",
  "placeholder": "What can I help you find?"
}
```

## Design Principles

- **Simplicity first**: Don't add components the user didn't ask for (except the mandatory chat)
- **Accessibility**: Ensure readable text contrast, reasonable touch targets
- **Mobile-friendly**: Responsive layouts work on all screen sizes
- **Performance**: Minimize custom CSS; prefer theme tokens over inline styles
- **Brand alignment**: Match colors and tone to the described brand identity
