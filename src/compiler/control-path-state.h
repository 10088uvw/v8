// Copyright 2022 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef V8_COMPILER_CONTROL_PATH_STATE_H_
#define V8_COMPILER_CONTROL_PATH_STATE_H_

#include "src/compiler/functional-list.h"
#include "src/compiler/graph-reducer.h"
#include "src/compiler/graph.h"
#include "src/compiler/node-aux-data.h"
#include "src/compiler/node-properties.h"
#include "src/compiler/node.h"
#include "src/compiler/persistent-map.h"
#include "src/zone/zone.h"

namespace v8 {
namespace internal {
namespace compiler {

// Class for tracking information about path state. It is represented
// as a linked list of {NodeState} blocks, each of which corresponds to a block
// of code bewteen an IfTrue/IfFalse and a Merge. Each block is in turn
// represented as a linked list of {NodeState}s.
template <typename NodeState>
class ControlPathState {
 public:
  static_assert(
      std::is_member_function_pointer<decltype(&NodeState::IsSet)>::value,
      "{NodeState} needs an {IsSet} method");
  static_assert(
      std::is_member_object_pointer<decltype(&NodeState::node)>::value,
      "{NodeState} needs to hold a pointer to the {Node*} owner of the state");

  explicit ControlPathState(Zone* zone) : states_(zone) {}

  // Returns the {NodeState} assigned to node, or the default value
  // {NodeState()} if it is not assigned.
  NodeState LookupState(Node* node) const {
    for (size_t depth = blocks_.Size(); depth > 0; depth--) {
      NodeState state = states_.Get({node, depth});
      if (state.IsSet()) return state;
    }
    return {};
  }

  // Adds a state in the current code block, or a new block if the block list is
  // empty.
  void AddState(Zone* zone, Node* node, NodeState state, ControlPathState hint);

  // Adds a state in a new block.
  void AddStateInNewBlock(Zone* zone, Node* node, NodeState state);

  // Reset this {ControlPathState} to its longest prefix that is common with
  // {other}.
  void ResetToCommonAncestor(ControlPathState other);

  bool IsEmpty() { return blocks_.Size() == 0; }

  bool operator==(const ControlPathState& other) const {
    return blocks_ == other.blocks_;
  }
  bool operator!=(const ControlPathState& other) const {
    return blocks_ != other.blocks_;
  }

 private:
  using NodeWithPathDepth = std::pair<Node*, size_t>;

#if DEBUG
  bool BlocksAndStatesInvariant() {
    PersistentMap<NodeWithPathDepth, NodeState> states_copy(states_);
    size_t depth = blocks_.Size();
    for (auto block : blocks_) {
      std::unordered_set<Node*> seen_this_block;
      for (NodeState state : block) {
        // Every element of blocks_ has to be in states_.
        if (seen_this_block.count(state.node) == 0) {
          if (states_copy.Get({state.node, depth}) != state) return false;
          states_copy.Set({state.node, depth}, {});
          seen_this_block.emplace(state.node);
        }
      }
      depth--;
    }
    // Every element of {states_} has to be in {blocks_}. We removed all
    // elements of blocks_ from states_copy, so if it is not empty, the
    // invariant fails.
    return states_copy.begin() == states_copy.end();
  }
#endif

  FunctionalList<FunctionalList<NodeState>> blocks_;
  // This is an auxilliary data structure that provides fast lookups in the
  // set of states. It should hold at any point that the contents of {blocks_}
  // and {states_} is the same, which is implemented in
  // {BlocksAndStatesInvariant}.
  PersistentMap<NodeWithPathDepth, NodeState> states_;
};

template <typename NodeState>
class AdvancedReducerWithControlPathState : public AdvancedReducer {
 protected:
  AdvancedReducerWithControlPathState(Editor* editor, Zone* zone, Graph* graph)
      : AdvancedReducer(editor),
        zone_(zone),
        node_states_(graph->NodeCount(), zone),
        reduced_(graph->NodeCount(), zone) {}
  Reduction TakeStatesFromFirstControl(Node* node);
  // Update the state of {state_owner} to {new_state}.
  Reduction UpdateStates(Node* state_owner,
                         ControlPathState<NodeState> new_state);
  // Update the state of {state_owner} to {prev_states}, plus {additional_state}
  // assigned to {additional_node}. Force the new state in a new block if
  // {in_new_block}.
  Reduction UpdateStates(Node* state_owner,
                         ControlPathState<NodeState> prev_states,
                         Node* additional_node, NodeState additional_state,
                         bool in_new_block);
  Zone* zone() { return zone_; }
  ControlPathState<NodeState> GetState(Node* node) {
    return node_states_.Get(node);
  }
  bool IsReduced(Node* node) { return reduced_.Get(node); }

 private:
  Zone* zone_;
  // Maps each control node to the node's current state.
  // If the information is nullptr, then we have not calculated the information
  // yet.
  NodeAuxData<ControlPathState<NodeState>,
              ZoneConstruct<ControlPathState<NodeState>>>
      node_states_;
  NodeAuxData<bool> reduced_;
};

template <typename NodeState>
void ControlPathState<NodeState>::AddState(Zone* zone, Node* node,
                                           NodeState state,
                                           ControlPathState<NodeState> hint) {
  FunctionalList<NodeState> prev_front = blocks_.Front();
  if (hint.blocks_.Size() > 0) {
    prev_front.PushFront(state, zone, hint.blocks_.Front());
  } else {
    prev_front.PushFront(state, zone);
  }
  blocks_.DropFront();
  blocks_.PushFront(prev_front, zone);
  states_.Set({node, blocks_.Size()}, state);
  SLOW_DCHECK(BlocksAndStatesInvariant());
}

template <typename NodeState>
void ControlPathState<NodeState>::AddStateInNewBlock(Zone* zone, Node* node,
                                                     NodeState state) {
  FunctionalList<NodeState> new_block;
  new_block.PushFront(state, zone);
  states_.Set({node, blocks_.Size() + 1}, state);
  blocks_.PushFront(new_block, zone);
  SLOW_DCHECK(BlocksAndStatesInvariant());
}

template <typename NodeState>
void ControlPathState<NodeState>::ResetToCommonAncestor(
    ControlPathState<NodeState> other) {
  while (other.blocks_.Size() > blocks_.Size()) other.blocks_.DropFront();
  while (blocks_.Size() > other.blocks_.Size()) {
    for (NodeState state : blocks_.Front()) {
      states_.Set({state.node, blocks_.Size()}, {});
    }
    blocks_.DropFront();
  }
  while (blocks_ != other.blocks_) {
    for (NodeState state : blocks_.Front()) {
      states_.Set({state.node, blocks_.Size()}, {});
    }
    blocks_.DropFront();
    other.blocks_.DropFront();
  }
  SLOW_DCHECK(BlocksAndStatesInvariant());
}

template <typename NodeState>
Reduction
AdvancedReducerWithControlPathState<NodeState>::TakeStatesFromFirstControl(
    Node* node) {
  // We just propagate the information from the control input (ideally,
  // we would only revisit control uses if there is change).
  Node* input = NodeProperties::GetControlInput(node, 0);
  if (!reduced_.Get(input)) return NoChange();
  return UpdateStates(node, node_states_.Get(input));
}

template <typename NodeState>
Reduction AdvancedReducerWithControlPathState<NodeState>::UpdateStates(
    Node* state_owner, ControlPathState<NodeState> new_state) {
  // Only signal that the node has {Changed} if its state has changed.
  bool reduced_changed = reduced_.Set(state_owner, true);
  bool node_states_changed = node_states_.Set(state_owner, new_state);
  if (reduced_changed || node_states_changed) {
    return Changed(state_owner);
  }
  return NoChange();
}

template <typename NodeState>
Reduction AdvancedReducerWithControlPathState<NodeState>::UpdateStates(
    Node* state_owner, ControlPathState<NodeState> prev_states,
    Node* additional_node, NodeState additional_state, bool in_new_block) {
  if (in_new_block || prev_states.IsEmpty()) {
    prev_states.AddStateInNewBlock(zone_, additional_node, additional_state);
  } else {
    ControlPathState<NodeState> original = node_states_.Get(state_owner);
    prev_states.AddState(zone_, additional_node, additional_state, original);
  }
  return UpdateStates(state_owner, prev_states);
}

}  // namespace compiler
}  // namespace internal
}  // namespace v8

#endif  // V8_COMPILER_CONTROL_PATH_STATE_H_
