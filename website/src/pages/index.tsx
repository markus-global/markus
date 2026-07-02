import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import Link from '@docusaurus/Link';
import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={styles.heroBanner}>
      <div className="container">
        <Heading as="h1" className={styles.heroTitle}>
          {siteConfig.title}
        </Heading>
        <p className={styles.heroSubtitle}>{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link className="button button--primary button--lg" to="/docs/intro">
            Get Started →
          </Link>
          <Link className="button button--secondary button--lg" to="/docs/architecture/overview">
            Architecture
          </Link>
        </div>
      </div>
    </header>
  );
}

const features = [
  {
    title: '🤖 Multi-Agent Orchestration',
    description: 'Hire, manage, and coordinate multiple AI agents that work like real employees — autonomously executing tasks, collaborating, and delivering results.',
  },
  {
    title: '🧠 Advanced Cognitive Architecture',
    description: 'Based on Kahneman dual-process theory and Baddeley working memory model. Agents think, reflect, and learn from experience.',
  },
  {
    title: '🔌 Extensible by Design',
    description: 'Plug-in architecture with 30+ built-in tools, MCP support, 9 LLM providers, and a skill system for unlimited extensibility.',
  },
  {
    title: '🔒 Enterprise Ready',
    description: 'Role-based access control, audit logging, task governance, data isolation, and progressive trust scoring keep your operations secure.',
  },
  {
    title: '🌐 Multi-Platform IM Integration',
    description: 'Communicate with your AI team via Slack, Feishu, Telegram, WhatsApp, or the built-in Web UI.',
  },
  {
    title: '📊 Task & Project Management',
    description: 'Built-in project management with DAG dependency graphs, requirement-driven workflows, and automated report generation.',
  },
];

function Feature({title, description}: {title: string; description: string}) {
  return (
    <div className="col col--4 margin-bottom--lg">
      <div className="card padding--lg" style={{height: '100%'}}>
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function Home(): React.ReactElement {
  return (
    <Layout description="Markus — AI Native Digital Employee Platform documentation">
      <HomepageHeader />
      <main>
        <section className="container margin-vert--xl">
          <div className="row">
            {features.map((f, idx) => (
              <Feature key={idx} {...f} />
            ))}
          </div>
        </section>
      </main>
    </Layout>
  );
}
