import * as React from 'react'
import { CornerDownLeft } from 'lucide-react'
import {
  Message,
  MessageHeader,
  MessageContent,
  MessageActions,
  MessageLoading,
  MessageResponse,
  StreamingIndicator,
  UserMessageContent,
} from '@/components/ai-elements/message'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { RichTextInput } from '@/components/ai-elements/rich-text-input'
import { CopyButton } from '@/components/chat/CopyButton'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type {
  PluginDocumentChatMessage,
  PluginDocumentChatReference,
  PluginWorkbenchDocumentChatNode,
} from '@proma/shared'

export interface PluginReadonlyChatState {
  draft: string
  pending: boolean
  error?: string
  references: PluginDocumentChatReference[]
  messages: PluginDocumentChatMessage[]
}

interface PluginReadonlyChatPanelProps {
  nodeKey: string
  chatNode: PluginWorkbenchDocumentChatNode
  state: PluginReadonlyChatState
  isWikiDocumentChat: boolean
  onDraftChange: (value: string) => void
  onSend: () => void
}

function formatMessageTime(timestamp: string | undefined): string {
  const date = timestamp ? new Date(timestamp) : new Date()
  const hh = date.getHours().toString().padStart(2, '0')
  const mm = date.getMinutes().toString().padStart(2, '0')
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  return `${month}/${day} ${hh}:${mm}`
}

/**
 * 插件版只读 Chat（用于 Wiki 问答，不具备 Agent 工具能力）
 */
export function PluginReadonlyChatPanel({
  nodeKey,
  chatNode,
  state,
  isWikiDocumentChat,
  onDraftChange,
  onSend,
}: PluginReadonlyChatPanelProps): React.ReactElement {
  const canSend = !state.pending && state.draft.trim().length > 0
  const hasAssistantMessage = state.messages.some((message) => message.role === 'assistant')
  const showLoadingOnly = state.pending && !hasAssistantMessage

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden rounded-xl',
        isWikiDocumentChat
          ? 'border-none bg-transparent p-0'
          : 'border border-border/60 bg-background/80 p-4',
      )}
    >
      {(chatNode.title || chatNode.description) && (
        <header className="space-y-1 shrink-0 pb-2">
          {chatNode.title && <h5 className="text-sm font-semibold text-foreground">{chatNode.title}</h5>}
          {chatNode.description && <p className="text-xs text-muted-foreground">{chatNode.description}</p>}
        </header>
      )}

      <div className={cn(
        'relative flex-1 min-h-0 overflow-hidden rounded-lg',
        isWikiDocumentChat
          ? 'border border-border/40 bg-background/70'
          : 'border border-border/50 bg-muted/10',
      )}>
        <Conversation className="h-full min-h-0">
          <ConversationContent className="p-3 space-y-2">
            {state.messages.length > 0 ? (
              state.messages.map((message, index) => {
                if (message.role === 'user') {
                  return (
                    <Message key={`${nodeKey}-message-${index}`} from="user">
                      <MessageContent className="pl-0 items-end">
                        <UserMessageContent className="max-w-[86%]">
                          {message.content}
                        </UserMessageContent>
                        <MessageActions className="justify-end pr-1">
                          <CopyButton content={message.content} />
                        </MessageActions>
                      </MessageContent>
                    </Message>
                  )
                }

                return (
                  <Message key={`${nodeKey}-message-${index}`} from="assistant">
                    <MessageHeader model="DeepWiki" time={formatMessageTime(message.createdAt)} />
                    <MessageContent className="pr-1">
                      <div className="prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:p-0">
                        <MessageResponse>{message.content}</MessageResponse>
                      </div>
                      <MessageActions className="mt-1.5">
                        <CopyButton content={message.content} />
                        {state.pending && index === state.messages.length - 1 ? <StreamingIndicator /> : null}
                      </MessageActions>
                    </MessageContent>
                  </Message>
                )
              })
            ) : (
              <div className="h-full min-h-[120px] flex items-center justify-center text-center">
                <p className="text-sm text-muted-foreground">
                  {chatNode.emptyText ?? '暂无对话，输入问题开始继续聊天。'}
                </p>
              </div>
            )}

            {showLoadingOnly ? (
              <Message from="assistant">
                <MessageHeader model="DeepWiki" time={formatMessageTime(undefined)} />
                <MessageContent>
                  <MessageLoading />
                </MessageContent>
              </Message>
            ) : null}
          </ConversationContent>
          <ConversationScrollButton className="bottom-3" />
        </Conversation>
      </div>

      {state.references.length > 0 && (
        <Collapsible className={cn(
          'mt-2 shrink-0 overflow-hidden rounded-lg',
          isWikiDocumentChat
            ? 'border border-border/30 bg-background/50'
            : 'border border-border/40 bg-muted/10',
        )}>
          <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/30 transition-colors">
            <div className="flex items-center gap-2">
              <span className="i-lucide-file-text w-3.5 h-3.5" />
              <span>查看参考来源 ({state.references.length})</span>
            </div>
            <span className="i-lucide-chevron-down w-3.5 h-3.5" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="px-3 pb-3 pt-1 space-y-1.5 max-h-[150px] overflow-y-auto">
              {state.references.map((item) => (
                <li key={`${nodeKey}-${item.chunkId}`} className="text-[11px] text-muted-foreground/80 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary/40 shrink-0" />
                  <span className="font-mono truncate flex-1">{item.filePath}</span>
                  <span className="opacity-60 shrink-0 border border-border/50 rounded px-1">{(item.score * 100).toFixed(1)}%</span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}

      {state.error && (
        <div className="mt-2 shrink-0 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
          <p className="text-xs font-medium text-destructive flex items-center gap-2">
            <span className="i-lucide-alert-circle w-4 h-4" />
            {state.error}
          </p>
        </div>
      )}

      <div className="mt-2 shrink-0 border-t border-border/40 pt-2">
        <div className="rounded-[17px] border-[0.5px] border-border bg-background/70 backdrop-blur-sm pt-2">
          <RichTextInput
            value={state.draft}
            onChange={onDraftChange}
            onSubmit={onSend}
            placeholder={chatNode.placeholder ?? '只读问答：基于 Wiki 与源码上下文提问...'}
            disabled={state.pending}
          />

          <div className="flex items-center justify-between px-2 py-[5px] h-[40px] gap-3">
            <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
              <span className="shrink-0 rounded-md border border-border/60 px-1.5 py-0.5">只读模式</span>
              <span className="truncate">文档库：{chatNode.knowledgeBaseId}</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                'size-[30px] rounded-full',
                canSend
                  ? 'text-primary hover:bg-primary/10'
                  : 'text-foreground/30 cursor-not-allowed',
              )}
              onClick={onSend}
              disabled={!canSend}
            >
              <CornerDownLeft className="size-[20px]" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
