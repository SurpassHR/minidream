import type { SkillCard } from '../api';

export default function SkillCards({
  skills,
  onTry,
}: {
  skills: SkillCard[];
  onTry: (skill: SkillCard) => void;
}) {
  return (
    <div className="skill-cards">
      {skills.map(skill => (
        <button key={skill.id} className="skill-card" onClick={() => onTry(skill)}>
          <div className="skill-card-media">
            <img className="skill-card-img" src={skill.image} alt={skill.title} loading="lazy" />
            <span className="skill-card-tag">{skill.tag}</span>
            <div className="skill-card-overlay">
              <span className="skill-card-title">{skill.title}</span>
              <span className="skill-card-try">
                试一试
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2.5 6h7m0 0L6.5 3M9.5 6 6.5 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </div>
          </div>
          <span className="skill-card-desc">{skill.desc}</span>
        </button>
      ))}
    </div>
  );
}
