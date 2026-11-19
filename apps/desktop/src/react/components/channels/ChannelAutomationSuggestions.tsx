import { useEffect, useState } from 'react';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import type { SuggestionCardBlock } from '../../stores/chat-types';
import { CronConfirmBlock } from '../chat/AssistantMessage';
import styles from './Channels.module.css';

interface ChannelSuggestion {
  sessionId: string;
  block: SuggestionCardBlock & { suggestionId: string };
}

export function ChannelAutomationSuggestions({ channelId }: { channelId: string }) {
  const pendingRevision = useStore(state => Object.values(state.channelAgentActivities[channelId] || {})
    .map(history => history.find(activity => activity.details?.automationSuggestionId)?.details?.automationSuggestionId)
    .filter(Boolean)
    .join(','));
  const [suggestions, setSuggestions] = useState<ChannelSuggestion[]>([]);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void hanaFetch(`/api/channels/${encodeURIComponent(channelId)}/automation-suggestions`, { signal: controller.signal })
      .then(response => response.json())
      .then(data => {
        if (!controller.signal.aborted) setSuggestions(data.suggestions || []);
      })
      .catch(error => {
        if (!controller.signal.aborted) console.warn('[channels] load automation suggestions failed:', error);
      });
    return () => controller.abort();
  }, [channelId, pendingRevision, refresh]);

  if (!suggestions.length) return null;
  return (
    <div className={styles.channelAutomationSuggestions}>
      {suggestions.map(({ sessionId, block }) => (
        <CronConfirmBlock
          key={block.suggestionId}
          block={block}
          suggestionSessionId={sessionId}
          onApproved={() => {
            setSuggestions(current => current.filter(item => item.block.suggestionId !== block.suggestionId));
            setRefresh(value => value + 1);
          }}
        />
      ))}
    </div>
  );
}
