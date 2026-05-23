import { MessageStream } from "@/components/session/MessageStream";
import type { Message } from "@/lib/types";

type Props = {
  messages: Message[] | undefined;
  hasMoreBefore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
};

export function MessagesSection({ messages, hasMoreBefore, loadingOlder, onLoadOlder }: Props): JSX.Element {
  return (
    <div className="h-[calc(100dvh-13rem)] min-h-[480px] overflow-hidden rounded-lg border border-border-subtle bg-card/40">
      <MessageStream
        messages={messages}
        hasMoreBefore={hasMoreBefore}
        loadingOlder={loadingOlder}
        onLoadOlder={onLoadOlder}
      />
    </div>
  );
}
