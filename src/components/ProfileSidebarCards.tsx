import { Icon } from '../assets/icons';
import './ProfileSidebarCards.css';

interface ProfileTagsCardProps {
  title: string;
  tags: string[];
  emptyMessage: string;
}

interface ProfileUpgradeCardProps {
  isPro: boolean;
  onClick: () => void;
}

export function ProfileTagsCard({ title, tags, emptyMessage }: ProfileTagsCardProps) {
  return (
    <section className="profile-sidebar-card card ag-liquid-glass-soft">
      <span className="section-title">{title}</span>
      {tags.length > 0 ? (
        <div className="profile-sidebar-card-tags">
          {tags.map((tag) => <span className="chip" key={tag}>{tag}</span>)}
        </div>
      ) : (
        <p className="profile-sidebar-card-empty">{emptyMessage}</p>
      )}
    </section>
  );
}

export function ProfileUpgradeCard({ isPro, onClick }: ProfileUpgradeCardProps) {
  return (
    <button type="button" className="profile-upgrade-card" onClick={onClick}>
      <span className="profile-upgrade-icon" aria-hidden="true">
        <Icon name="crown" />
      </span>
      <span>
        <strong>{isPro ? 'ArtGuard Pro active' : 'Upgrade to Pro'}</strong>
        <small>{isPro ? 'Your mock Pro benefits are enabled' : '0% transaction fees, advanced shielding'}</small>
      </span>
      <Icon name="chevron-r" />
    </button>
  );
}
